// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC7579Hook {
    function onInstall(bytes calldata data) external payable;
    function onUninstall(bytes calldata data) external payable;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
    function isInitialized(address smartAccount) external view returns (bool);
    function preCheck(address msgSender, uint256 msgValue, bytes calldata msgData)
        external
        payable
        returns (bytes memory hookData);
    function postCheck(bytes calldata hookData) external payable;
}

contract TradingAgentPolicyValidator is IERC7579Hook {
    uint256 public constant BSC_MAINNET_CHAIN_ID = 56;
    uint256 public constant BSC_TESTNET_CHAIN_ID = 97;
    uint256 public constant MODULE_TYPE_HOOK = 4;
    uint256 public constant MAX_TRADE_VALUE = 0.5 ether;
    uint256 public constant MAX_ROLLING_VOLUME = 1 ether;
    uint256 public constant ROLLING_WINDOW = 604_800;
    uint256 public constant MAX_ACTIVE_TRADES = 128;
    bytes4 public constant BUY_SELECTOR = 0x7ff36ab5;

    bytes4 private constant EXECUTE_SELECTOR = bytes4(keccak256("execute(bytes32,bytes)"));
    bytes4 private constant FACTORY_SELECTOR = 0xc45a0155;
    uint256 private constant ROUTER_BUY_CALL_LENGTH = 228;
    uint256 private constant INTENT_ENVELOPE_LENGTH = 320;
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant EIP712_NAME_HASH = keccak256("WolvTradingAgent");
    bytes32 private constant EIP712_VERSION_HASH = keccak256("1");
    bytes32 private constant TRADE_INTENT_TYPEHASH = keccak256(
        "TradeIntent(address smartAccount,bytes32 policyHash,address targetToken,uint256 amountIn,uint256 amountOutMin,uint16 slippageBps,uint16 maxPriceImpactBps,uint64 validUntil,bytes32 nonce)"
    );
    address private constant BSC_MAINNET_WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address private constant BSC_TESTNET_WBNB = 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd;

    address public immutable approvedRouter;
    address public immutable entryPoint;
    address public immutable wrappedNativeToken;
    address public immutable guardian;
    uint256 public immutable deploymentChainId;
    bool public paused;

    struct Trade {
        uint64 timestamp;
        uint192 value;
    }

    struct AccountState {
        bool installed;
        bool revoked;
        address targetToken;
        uint256 rollingVolume;
        uint256 head;
        uint256 tail;
        mapping(uint256 => Trade) trades;
        bool policyConfigured;
        bytes32 policyHash;
        uint64 policyExpiresAt;
        uint192 maxTradeValue;
        address intentSigner;
        mapping(bytes32 => bool) consumedIntentNonces;
    }

    struct TradeIntent {
        address smartAccount;
        bytes32 policyHash;
        address targetToken;
        uint256 amountIn;
        uint256 amountOutMin;
        uint16 slippageBps;
        uint16 maxPriceImpactBps;
        uint64 validUntil;
        bytes32 nonce;
    }

    struct DecodedTrade {
        address target;
        uint256 value;
        bytes4 selector;
        address pathStart;
        address tokenOut;
        address recipient;
        uint256 amountOutMin;
        bytes32 intentPolicyHash;
        bytes32 intentNonce;
        uint64 intentValidUntil;
        uint16 slippageBps;
        uint16 maxPriceImpactBps;
        bytes intentSignature;
    }

    mapping(address => AccountState) private accountStates;

    error UnsupportedChain(uint256 chainId);
    error ZeroAddress();
    error AddressHasNoCode(address account);
    error RouterFactoryCheckFailed(address router);
    error AlreadyInitialized(address smartAccount);
    error NotInitialized(address smartAccount);
    error OnlyEntryPoint(address caller);
    error UnexpectedHookValue(uint256 value);
    error InvalidHookData();
    error InvalidKernelCallData();
    error UnsupportedExecutionMode(bytes32 mode);
    error InvalidExecutionCalldata();
    error WrongTarget(address target);
    error UnsupportedSelector(bytes4 selector);
    error ZeroTradeValue();
    error TradeValueTooHigh(uint256 value, uint256 maximum);
    error RollingWindowCapExceeded(uint256 attemptedVolume, uint256 maximum);
    error TooManyActiveTrades(uint256 maximum);
    error TimestampOverflow();
    error InvalidSwapRoute();
    error OnlyGuardian(address caller);
    error AgentPaused();
    error AccountRevoked(address smartAccount);
    error InvalidTelemetryReason();
    error PolicyNotConfigured(address smartAccount);
    error PolicyExpired(address smartAccount);
    error PolicyHashInvalid();
    error PolicyExpiryInvalid();
    error PolicyTradeCapInvalid(uint256 maximum);
    error PolicyIntentSignerInvalid();
    error PolicyIntentHashMismatch();
    error PolicyIntentExpired();
    error PolicyIntentNonceInvalid();
    error PolicyIntentReplay(bytes32 nonce);
    error PolicyIntentSignatureInvalid();
    error PolicyIntentParametersInvalid();

    event CircuitBreakerUpdated(bool paused, address indexed guardian);
    event AgentAccountRevoked(address indexed smartAccount, address indexed guardian);
    event AgentExecutionAttempt(
        address indexed smartAccount,
        address indexed targetToken,
        uint256 value,
        uint256 timestamp
    );
    event AgentExecutionSucceeded(
        address indexed smartAccount,
        address indexed targetToken,
        uint256 value,
        uint256 timestamp
    );
    event PolicyViolationRejected(
        address indexed smartAccount,
        bytes32 indexed reasonCode,
        bytes32 contextHash,
        uint256 timestamp
    );
    event AccountPolicyConfigured(
        address indexed smartAccount,
        bytes32 indexed policyHash,
        uint256 maxTradeValue,
        uint64 expiresAt,
        address intentSigner,
        address indexed guardian
    );
    event AccountPolicyCleared(
        address indexed smartAccount,
        address indexed guardian
    );

    constructor(address approvedRouter_, address entryPoint_) {
        if (block.chainid != BSC_MAINNET_CHAIN_ID && block.chainid != BSC_TESTNET_CHAIN_ID) {
            revert UnsupportedChain(block.chainid);
        }
        if (approvedRouter_ == address(0) || entryPoint_ == address(0)) {
            revert ZeroAddress();
        }
        if (approvedRouter_.code.length == 0) {
            revert AddressHasNoCode(approvedRouter_);
        }
        if (entryPoint_.code.length == 0) {
            revert AddressHasNoCode(entryPoint_);
        }
        if (!_hasFactory(approvedRouter_)) {
            revert RouterFactoryCheckFailed(approvedRouter_);
        }

        approvedRouter = approvedRouter_;
        entryPoint = entryPoint_;
        guardian = msg.sender;
        deploymentChainId = block.chainid;
        wrappedNativeToken = block.chainid == BSC_MAINNET_CHAIN_ID
            ? BSC_MAINNET_WBNB
            : BSC_TESTNET_WBNB;
    }

    function onInstall(bytes calldata data) external payable {
        if (msg.value != 0) revert UnexpectedHookValue(msg.value);
        if (data.length != 32) revert InvalidHookData();
        address targetToken = abi.decode(data, (address));
        if (targetToken == address(0) || targetToken.code.length == 0) {
            revert InvalidHookData();
        }
        AccountState storage state = accountStates[msg.sender];
        if (state.installed) revert AlreadyInitialized(msg.sender);
        state.revoked = false;
        state.targetToken = targetToken;
        state.installed = true;
    }

    function onUninstall(bytes calldata data) external payable {
        if (msg.value != 0) revert UnexpectedHookValue(msg.value);
        if (data.length != 0) revert InvalidHookData();
        AccountState storage state = accountStates[msg.sender];
        if (!state.installed) revert NotInitialized(msg.sender);
        state.installed = false;
        state.targetToken = address(0);
    }

    function setPaused(bool paused_) external {
        if (msg.sender != guardian) revert OnlyGuardian(msg.sender);
        if (paused == paused_) return;
        paused = paused_;
        emit CircuitBreakerUpdated(paused_, guardian);
    }

    function revokeAccount(address smartAccount) external {
        if (msg.sender != guardian) revert OnlyGuardian(msg.sender);
        if (smartAccount == address(0)) revert ZeroAddress();
        AccountState storage state = accountStates[smartAccount];
        state.revoked = true;
        emit AgentAccountRevoked(smartAccount, guardian);
    }

    function setAccountPolicy(
        address smartAccount,
        address intentSigner,
        bytes32 policyHash,
        uint192 maxTradeValue,
        uint64 expiresAt
    ) external {
        if (msg.sender != guardian) revert OnlyGuardian(msg.sender);
        AccountState storage state = accountStates[smartAccount];
        if (!state.installed) revert NotInitialized(smartAccount);
        if (intentSigner == address(0)) revert PolicyIntentSignerInvalid();
        if (policyHash == bytes32(0)) revert PolicyHashInvalid();
        if (expiresAt <= block.timestamp || expiresAt > type(uint64).max) {
            revert PolicyExpiryInvalid();
        }
        if (maxTradeValue == 0 || maxTradeValue > MAX_TRADE_VALUE) {
            revert PolicyTradeCapInvalid(maxTradeValue);
        }
        state.policyConfigured = true;
        state.policyHash = policyHash;
        state.policyExpiresAt = expiresAt;
        state.maxTradeValue = maxTradeValue;
        state.intentSigner = intentSigner;
        emit AccountPolicyConfigured(
            smartAccount,
            policyHash,
            maxTradeValue,
            expiresAt,
            intentSigner,
            guardian
        );
    }

    function clearAccountPolicy(address smartAccount) external {
        if (msg.sender != guardian) revert OnlyGuardian(msg.sender);
        AccountState storage state = accountStates[smartAccount];
        state.policyConfigured = false;
        state.policyHash = bytes32(0);
        state.policyExpiresAt = 0;
        state.maxTradeValue = 0;
        state.intentSigner = address(0);
        emit AccountPolicyCleared(smartAccount, guardian);
    }

    function recordPolicyViolation(
        address smartAccount,
        bytes32 reasonCode,
        bytes32 contextHash
    ) external {
        if (msg.sender != guardian) revert OnlyGuardian(msg.sender);
        if (smartAccount == address(0) || reasonCode == bytes32(0)) {
            revert InvalidTelemetryReason();
        }
        emit PolicyViolationRejected(smartAccount, reasonCode, contextHash, block.timestamp);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_HOOK;
    }

    function isInitialized(address smartAccount) external view returns (bool) {
        return accountStates[smartAccount].installed;
    }

    function isRevoked(address smartAccount) external view returns (bool) {
        return accountStates[smartAccount].revoked;
    }

    function preCheck(address msgSender, uint256 msgValue, bytes calldata msgData)
        external
        payable
        returns (bytes memory hookData)
    {
        if (paused) revert AgentPaused();
        if (msgSender != entryPoint) revert OnlyEntryPoint(msgSender);
        if (msg.value != 0) revert UnexpectedHookValue(msg.value);
        if (msgValue != 0) revert UnexpectedHookValue(msgValue);

        AccountState storage state = accountStates[msg.sender];
        if (!state.installed) revert NotInitialized(msg.sender);
        if (state.revoked) revert AccountRevoked(msg.sender);

        DecodedTrade memory trade = _decodeTrade(msgData);
        if (trade.target != approvedRouter) revert WrongTarget(trade.target);
        if (trade.selector != BUY_SELECTOR) revert UnsupportedSelector(trade.selector);
        if (
            trade.pathStart != wrappedNativeToken || trade.tokenOut != state.targetToken
                || trade.recipient != msg.sender
        ) {
            revert InvalidSwapRoute();
        }
        if (trade.value == 0) revert ZeroTradeValue();
        _validateTradeIntent(state, trade, msg.sender);
        if (block.timestamp > type(uint64).max) revert TimestampOverflow();

        _expireTrades(state);
        uint256 attemptedVolume = state.rollingVolume + trade.value;
        if (attemptedVolume > MAX_ROLLING_VOLUME) {
            revert RollingWindowCapExceeded(attemptedVolume, MAX_ROLLING_VOLUME);
        }
        if (state.tail - state.head >= MAX_ACTIVE_TRADES) {
            revert TooManyActiveTrades(MAX_ACTIVE_TRADES);
        }

        state.trades[state.tail % MAX_ACTIVE_TRADES] =
            Trade({timestamp: uint64(block.timestamp), value: uint192(trade.value)});
        state.tail += 1;
        state.rollingVolume = attemptedVolume;
        state.consumedIntentNonces[trade.intentNonce] = true;
        emit AgentExecutionAttempt(msg.sender, state.targetToken, trade.value, block.timestamp);
        return abi.encode(state.targetToken, trade.value, trade.intentNonce);
    }

    function postCheck(bytes calldata hookData) external payable {
        if (msg.value != 0) revert UnexpectedHookValue(msg.value);
        if (hookData.length != 96) revert InvalidHookData();
        AccountState storage state = accountStates[msg.sender];
        if (!state.installed) {
            revert NotInitialized(msg.sender);
        }
        (address targetToken, uint256 value, bytes32 nonce) =
            abi.decode(hookData, (address, uint256, bytes32));
        if (
            targetToken != state.targetToken || value == 0
                || !state.consumedIntentNonces[nonce]
        ) revert InvalidHookData();
        emit AgentExecutionSucceeded(msg.sender, targetToken, value, block.timestamp);
    }

    function getRollingVolume(address account) external view returns (uint256) {
        return accountStates[account].rollingVolume;
    }

    function getAccountPolicy(address account)
        external
        view
        returns (
            bool configured,
            bytes32 policyHash,
            uint192 maxTradeValue,
            uint64 expiresAt,
            address intentSigner
        )
    {
        AccountState storage state = accountStates[account];
        return (
            state.policyConfigured,
            state.policyHash,
            state.maxTradeValue,
            state.policyExpiresAt,
            state.intentSigner
        );
    }

    function hashTradeIntent(TradeIntent calldata intent) external view returns (bytes32) {
        return _hashTradeIntent(intent);
    }

    function isIntentNonceConsumed(address account, bytes32 nonce)
        external
        view
        returns (bool)
    {
        return accountStates[account].consumedIntentNonces[nonce];
    }

    function getEffectiveRollingVolume(address account) external view returns (uint256 volume) {
        AccountState storage state = accountStates[account];
        for (uint256 index = state.head; index < state.tail; index++) {
            Trade storage trade = state.trades[index % MAX_ACTIVE_TRADES];
            if (block.timestamp < uint256(trade.timestamp) + ROLLING_WINDOW) {
                volume += trade.value;
            }
        }
    }

    function getTargetToken(address account) external view returns (address) {
        return accountStates[account].targetToken;
    }

    function getActiveTradeCount(address account) external view returns (uint256) {
        AccountState storage state = accountStates[account];
        return state.tail - state.head;
    }

    function _decodeTrade(bytes calldata callData)
        private
        pure
        returns (DecodedTrade memory trade)
    {
        if (callData.length < 4 || _selectorAt(callData, 0) != EXECUTE_SELECTOR) {
            revert InvalidKernelCallData();
        }
        if (callData.length < 100) revert InvalidKernelCallData();

        bytes calldata args = callData[4:];
        bytes32 mode;
        uint256 dataOffset;
        uint256 dataLength;
        assembly {
            mode := calldataload(args.offset)
            dataOffset := calldataload(add(args.offset, 32))
            dataLength := calldataload(add(args.offset, 64))
        }

        if (mode != bytes32(0)) revert UnsupportedExecutionMode(mode);
        if (dataOffset != 64 || dataLength > args.length - 96) {
            revert InvalidKernelCallData();
        }

        uint256 paddedLength = (dataLength + 31) & ~uint256(31);
        if (args.length != 96 + paddedLength) {
            revert InvalidKernelCallData();
        }
        if (dataLength < 52 + ROUTER_BUY_CALL_LENGTH) revert InvalidExecutionCalldata();

        bytes calldata execution = args[96:96 + dataLength];
        trade = _decodeExecutionTarget(execution);
        bytes calldata routerCall = execution[52:];
        return _decodeRouterCall(routerCall, trade);
    }

    function _decodeExecutionTarget(bytes calldata execution)
        private
        pure
        returns (DecodedTrade memory trade)
    {
        if (execution.length < 52) revert InvalidExecutionCalldata();
        assembly {
            mstore(trade, shr(96, calldataload(execution.offset)))
            mstore(add(trade, 32), calldataload(add(execution.offset, 20)))
            mstore(add(trade, 64), calldataload(add(execution.offset, 52)))
        }
    }

    function _decodeRouterCall(bytes calldata routerCall, DecodedTrade memory trade)
        private
        pure
        returns (DecodedTrade memory)
    {
        if (trade.selector != BUY_SELECTOR) return trade;
        if (routerCall.length < ROUTER_BUY_CALL_LENGTH + INTENT_ENVELOPE_LENGTH) {
            revert InvalidExecutionCalldata();
        }
        if (routerCall.length != ROUTER_BUY_CALL_LENGTH + INTENT_ENVELOPE_LENGTH) revert InvalidSwapRoute();
        uint256 pathOffset;
        uint256 pathLength;
        assembly {
            mstore(add(trade, 192), calldataload(add(routerCall.offset, 4)))
            pathOffset := calldataload(add(routerCall.offset, 36))
            mstore(add(trade, 160), and(
                calldataload(add(routerCall.offset, 68)),
                0xffffffffffffffffffffffffffffffffffffffff
            ))
        }
        if (trade.amountOutMin == 0 || pathOffset != 128) revert InvalidSwapRoute();
        assembly {
            pathLength := calldataload(add(routerCall.offset, 132))
            mstore(add(trade, 96), and(
                calldataload(add(routerCall.offset, 164)),
                0xffffffffffffffffffffffffffffffffffffffff
            ))
            mstore(add(trade, 128), and(
                calldataload(add(routerCall.offset, 196)),
                0xffffffffffffffffffffffffffffffffffffffff
            ))
        }
        if (pathLength != 2) revert InvalidSwapRoute();
        (
            trade.intentPolicyHash,
            trade.intentNonce,
            trade.intentValidUntil,
            trade.slippageBps,
            trade.maxPriceImpactBps,
            trade.intentSignature
        ) = abi.decode(
            routerCall[ROUTER_BUY_CALL_LENGTH:],
            (bytes32, bytes32, uint64, uint16, uint16, bytes)
        );
        return trade;
    }

    function _validateTradeIntent(
        AccountState storage state,
        DecodedTrade memory trade,
        address smartAccount
    ) private view {
        if (!state.policyConfigured || state.intentSigner == address(0)) {
            revert PolicyNotConfigured(smartAccount);
        }
        if (state.policyExpiresAt <= block.timestamp) revert PolicyExpired(smartAccount);
        if (trade.intentPolicyHash != state.policyHash) revert PolicyIntentHashMismatch();
        if (
            trade.intentValidUntil <= block.timestamp
                || trade.intentValidUntil > state.policyExpiresAt
        ) revert PolicyIntentExpired();
        if (trade.intentNonce == bytes32(0)) revert PolicyIntentNonceInvalid();
        if (state.consumedIntentNonces[trade.intentNonce]) {
            revert PolicyIntentReplay(trade.intentNonce);
        }
        if (
            trade.slippageBps == 0 || trade.slippageBps > 500
                || trade.maxPriceImpactBps == 0 || trade.maxPriceImpactBps > 300
                || trade.intentSignature.length != 65
        ) revert PolicyIntentParametersInvalid();
        if (trade.value > state.maxTradeValue) {
            revert TradeValueTooHigh(trade.value, state.maxTradeValue);
        }

        TradeIntent memory intent = TradeIntent({
            smartAccount: smartAccount,
            policyHash: trade.intentPolicyHash,
            targetToken: trade.tokenOut,
            amountIn: trade.value,
            amountOutMin: trade.amountOutMin,
            slippageBps: trade.slippageBps,
            maxPriceImpactBps: trade.maxPriceImpactBps,
            validUntil: trade.intentValidUntil,
            nonce: trade.intentNonce
        });
        if (_recoverSigner(_hashTradeIntent(intent), trade.intentSignature) != state.intentSigner) {
            revert PolicyIntentSignatureInvalid();
        }
    }

    function _hashTradeIntent(TradeIntent memory intent) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TRADE_INTENT_TYPEHASH,
                intent.smartAccount,
                intent.policyHash,
                intent.targetToken,
                intent.amountIn,
                intent.amountOutMin,
                intent.slippageBps,
                intent.maxPriceImpactBps,
                intent.validUntil,
                intent.nonce
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                EIP712_NAME_HASH,
                EIP712_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _recoverSigner(bytes32 digest, bytes memory signature)
        private
        pure
        returns (address signer)
    {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (uint256(s) > SECP256K1_HALF_ORDER || (v != 27 && v != 28)) {
            return address(0);
        }
        signer = ecrecover(digest, v, r, s);
    }

    function _expireTrades(AccountState storage state) private {
        while (state.head < state.tail) {
            uint256 slot = state.head % MAX_ACTIVE_TRADES;
            Trade storage trade = state.trades[slot];
            if (block.timestamp < uint256(trade.timestamp) + ROLLING_WINDOW) {
                break;
            }

            state.rollingVolume -= trade.value;
            delete state.trades[slot];
            state.head += 1;
        }
    }

    function _hasFactory(address router) private view returns (bool) {
        (bool success, bytes memory result) = router.staticcall(abi.encodeWithSelector(FACTORY_SELECTOR));
        if (!success || result.length < 32) return false;

        address factory = abi.decode(result, (address));
        return factory != address(0) && factory.code.length > 0;
    }

    function _selectorAt(bytes calldata data, uint256 offset) private pure returns (bytes4 selector) {
        assembly {
            selector := calldataload(add(data.offset, offset))
        }
    }
}
