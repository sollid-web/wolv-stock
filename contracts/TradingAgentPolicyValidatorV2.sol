// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IChainlinkAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}
interface IERC20Decimals { function decimals() external view returns (uint8); }
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

contract TradingAgentPolicyValidatorV2 is IERC7579Hook {
    uint256 public constant BSC_MAINNET_CHAIN_ID = 56;
    uint256 public constant BSC_TESTNET_CHAIN_ID = 97;
    uint256 public constant MODULE_TYPE_HOOK = 4;
    uint256 public constant MAX_TRADE_VALUE = 0.5 ether;
    uint256 public constant MAX_ROLLING_VOLUME = 1 ether;
    uint256 public constant ROLLING_WINDOW = 604_800;
    uint256 public constant MAX_ACTIVE_TRADES = 128;
    uint256 public constant MAX_SWAP_DEADLINE_SECONDS = 15;
    bytes4 public constant BUY_SELECTOR = 0x7ff36ab5;

    bytes4 private constant EXECUTE_SELECTOR = bytes4(keccak256("execute(bytes32,bytes)"));
    bytes4 private constant FACTORY_SELECTOR = 0xc45a0155;
    bytes4 private constant SET_ACCOUNT_POLICY_SELECTOR =
        bytes4(keccak256("setAccountPolicy(address,address,bytes32,uint192,uint64,uint64,uint16,uint16)"));
    bytes4 private constant CLEAR_ACCOUNT_POLICY_SELECTOR =
        bytes4(keccak256("clearAccountPolicy(address)"));
    bytes4 private constant REVOKE_ACCOUNT_SELECTOR =
        bytes4(keccak256("revokeAccount(address)"));
    uint256 private constant ROUTER_BUY_CALL_LENGTH = 228;
    uint256 private constant INTENT_ENVELOPE_LENGTH = 320;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant PRICE_SCALE = 1e18;
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant EIP712_NAME_HASH = keccak256("WolvTradingAgent");
    bytes32 private constant EIP712_VERSION_HASH = keccak256("1");
    bytes32 private constant TRADE_INTENT_TYPEHASH = keccak256(
        "TradeIntent(address smartAccount,bytes32 policyHash,address router,address tokenIn,address tokenOut,address recipient,uint256 amountIn,uint256 amountOutMin,uint64 deadline,uint16 slippageBps,uint16 maxPriceImpactBps,uint64 validUntil,bytes32 nonce)"
    );
    address private constant BSC_MAINNET_WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address private constant BSC_TESTNET_WBNB = 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd;

    address public immutable approvedRouter;
    address public immutable entryPoint;
    address public immutable wrappedNativeToken;
    address public immutable guardian;
    address public immutable bnbUsdFeed;
    mapping(address => address) public tokenUsdFeeds;
    mapping(address => uint32) public tokenFeedMaxAge;
    uint32 public bnbFeedMaxAge = 3600;
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
        uint64 entryPriceMicros;
        uint16 maxSlippageBps;
        uint16 maxPriceImpactBps;
        mapping(bytes32 => bool) consumedIntentNonces;
    }

    struct TradeIntent {
        address smartAccount;
        bytes32 policyHash;
        address router;
        address tokenIn;
        address tokenOut;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMin;
        uint64 deadline;
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
        uint256 deadline;
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
    error OnlySmartAccount(address caller);
    error ZeroTradeValue();
    error TradeValueTooHigh(uint256 value, uint256 maximum);
    error RollingWindowCapExceeded(uint256 attemptedVolume, uint256 maximum);
    error TooManyActiveTrades(uint256 maximum);
    error TimestampOverflow();
    error InvalidSwapRoute();
    error OnlyGuardian(address caller);
    error AgentPaused();
    error AccountRevoked(address smartAccount);
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
    error SwapDeadlineInvalid(uint256 deadline);
    error InvalidOracleFeed(address feed);
    error OraclePriceUnavailable(address feed);
    error OraclePriceAboveEntryLimit(uint256 priceMicros, uint256 maximum);
    error OraclePriceImpactExceeded(uint256 minimumOut, uint256 oracleMinimumOut);
    error PolicyRiskParametersInvalid();
    error TradeRiskLimitExceeded();

    event CircuitBreakerUpdated(bool paused, address indexed guardian);
    event AgentAccountRevoked(address indexed smartAccount);
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
    event AccountPolicyConfigured(
        address indexed smartAccount,
        bytes32 indexed policyHash,
        uint256 maxTradeValue,
        uint64 expiresAt,
        address intentSigner
    );
    event AccountPolicyCleared(address indexed smartAccount);
    event TokenUsdFeedUpdated(address indexed token, address indexed feed, uint32 maxAge);
    event BnbFeedMaxAgeUpdated(uint32 maxAge);
    event AccountRiskPolicyConfigured(address indexed smartAccount, uint64 entryPriceMicros, uint16 maxSlippageBps, uint16 maxPriceImpactBps);
    event TokenUsdFeedCleared(address indexed token);

    constructor(address approvedRouter_, address entryPoint_, address bnbUsdFeed_) {
        if (block.chainid != BSC_MAINNET_CHAIN_ID && block.chainid != BSC_TESTNET_CHAIN_ID) {
            revert UnsupportedChain(block.chainid);
        }
        if (approvedRouter_ == address(0) || entryPoint_ == address(0) || bnbUsdFeed_ == address(0)) {
            revert ZeroAddress();
        }
        if (approvedRouter_.code.length == 0) {
            revert AddressHasNoCode(approvedRouter_);
        }
        if (entryPoint_.code.length == 0) {
            revert AddressHasNoCode(entryPoint_);
        }
        if (bnbUsdFeed_.code.length == 0) revert AddressHasNoCode(bnbUsdFeed_);
        if (!_hasFactory(approvedRouter_)) {
            revert RouterFactoryCheckFailed(approvedRouter_);
        }

        approvedRouter = approvedRouter_;
        entryPoint = entryPoint_;
        bnbUsdFeed = bnbUsdFeed_;
        _validateFeed(bnbUsdFeed_, 3600);
        guardian = msg.sender;
        deploymentChainId = block.chainid;
        wrappedNativeToken = block.chainid == BSC_MAINNET_CHAIN_ID
            ? BSC_MAINNET_WBNB
            : BSC_TESTNET_WBNB;
    }

    function onInstall(bytes calldata data) external payable {
        if (msg.value != 0) revert UnexpectedHookValue(msg.value);
        if (data.length != 33 || data[0] != bytes1(0)) revert InvalidHookData();
        address targetToken = abi.decode(data[1:], (address));
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
        if (state.policyConfigured) emit AccountPolicyCleared(msg.sender);
        state.policyConfigured = false;
        state.policyHash = bytes32(0);
        state.policyExpiresAt = 0;
        state.maxTradeValue = 0;
        state.intentSigner = address(0);
        state.entryPriceMicros = 0;
        state.maxSlippageBps = 0;
        state.maxPriceImpactBps = 0;
    }

    function setTokenUsdFeed(address token, address feed, uint32 maxAge) external {
        if (msg.sender != guardian) revert OnlyGuardian(msg.sender);
        if (token == address(0) || token.code.length == 0 || feed == address(0) || feed.code.length == 0 || maxAge < 60 || maxAge > 86_400) revert InvalidOracleFeed(feed);
        _validateFeed(feed, maxAge);
        tokenUsdFeeds[token] = feed;
        tokenFeedMaxAge[token] = maxAge;
        emit TokenUsdFeedUpdated(token, feed, maxAge);
    }
    function clearTokenUsdFeed(address token) external {
        if (msg.sender != guardian) revert OnlyGuardian(msg.sender);
        delete tokenUsdFeeds[token];
        delete tokenFeedMaxAge[token];
        emit TokenUsdFeedCleared(token);
    }
    function setBnbFeedMaxAge(uint32 maxAge) external {
        if (msg.sender != guardian) revert OnlyGuardian(msg.sender);
        if (maxAge < 60 || maxAge > 86_400) revert InvalidOracleFeed(bnbUsdFeed);
        bnbFeedMaxAge = maxAge;
        emit BnbFeedMaxAgeUpdated(maxAge);
    }
    function setPaused(bool paused_) external {
        if (msg.sender != guardian) revert OnlyGuardian(msg.sender);
        if (paused == paused_) return;
        paused = paused_;
        emit CircuitBreakerUpdated(paused_, guardian);
    }

    function revokeAccount(address smartAccount) external {
        if (msg.sender != smartAccount) revert OnlySmartAccount(msg.sender);
        if (smartAccount == address(0)) revert ZeroAddress();
        AccountState storage state = accountStates[smartAccount];
        if (!state.installed) revert NotInitialized(smartAccount);
        state.revoked = true;
        emit AgentAccountRevoked(smartAccount);
    }

    function setAccountPolicy(
        address smartAccount,
        address intentSigner,
        bytes32 policyHash,
        uint192 maxTradeValue,
        uint64 expiresAt,
        uint64 entryPriceMicros,
        uint16 maxSlippageBps,
        uint16 maxPriceImpactBps
    ) external {
        if (msg.sender != smartAccount) revert OnlySmartAccount(msg.sender);
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
        if (entryPriceMicros == 0 || maxSlippageBps == 0 || maxSlippageBps > 500 || maxPriceImpactBps == 0 || maxPriceImpactBps > 300) revert PolicyRiskParametersInvalid();
        state.entryPriceMicros = entryPriceMicros;
        state.maxSlippageBps = maxSlippageBps;
        state.maxPriceImpactBps = maxPriceImpactBps;
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
            intentSigner
        );
        emit AccountRiskPolicyConfigured(
            smartAccount,
            entryPriceMicros,
            maxSlippageBps,
            maxPriceImpactBps
        );
    }

    function clearAccountPolicy(address smartAccount) external {
        if (msg.sender != smartAccount) revert OnlySmartAccount(msg.sender);
        AccountState storage state = accountStates[smartAccount];
        state.policyConfigured = false;
        state.policyHash = bytes32(0);
        state.policyExpiresAt = 0;
        state.maxTradeValue = 0;
        state.intentSigner = address(0);
        state.entryPriceMicros = 0;
        state.maxSlippageBps = 0;
        state.maxPriceImpactBps = 0;
        emit AccountPolicyCleared(smartAccount);
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
        if (
            trade.target == address(this) && trade.value == 0
                && _isPolicyManagementSelector(trade.selector)
        ) {
            return bytes("");
        }
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
        if (hookData.length == 0) return;
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

    function getAccountRiskPolicy(address account) external view returns (uint64, uint16, uint16) {
        AccountState storage state = accountStates[account];
        return (state.entryPriceMicros, state.maxSlippageBps, state.maxPriceImpactBps);
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
        if (dataLength < 56) revert InvalidExecutionCalldata();

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
            mstore(add(trade, 224), calldataload(add(routerCall.offset, 100)))
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
        if (
            trade.deadline <= block.timestamp
                || trade.deadline > block.timestamp + MAX_SWAP_DEADLINE_SECONDS
                || trade.deadline > trade.intentValidUntil
                || trade.deadline > type(uint64).max
        ) revert SwapDeadlineInvalid(trade.deadline);
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

        if (trade.slippageBps > state.maxSlippageBps || trade.maxPriceImpactBps > state.maxPriceImpactBps) revert TradeRiskLimitExceeded();
        _validateOracleExecution(state, trade);

        TradeIntent memory intent = TradeIntent({
            smartAccount: smartAccount,
            policyHash: trade.intentPolicyHash,
            router: trade.target,
            tokenIn: trade.pathStart,
            tokenOut: trade.tokenOut,
            recipient: trade.recipient,
            amountIn: trade.value,
            amountOutMin: trade.amountOutMin,
            deadline: uint64(trade.deadline),
            slippageBps: trade.slippageBps,
            maxPriceImpactBps: trade.maxPriceImpactBps,
            validUntil: trade.intentValidUntil,
            nonce: trade.intentNonce
        });
        if (_recoverSigner(_hashTradeIntent(intent), trade.intentSignature) != state.intentSigner) {
            revert PolicyIntentSignatureInvalid();
        }
    }

    function _validateOracleExecution(AccountState storage state, DecodedTrade memory trade) private view {
        address tokenFeed = tokenUsdFeeds[trade.tokenOut];
        uint32 tokenMaxAge = tokenFeedMaxAge[trade.tokenOut];
        if (tokenFeed == address(0) || tokenMaxAge == 0) revert InvalidOracleFeed(tokenFeed);
        uint256 tokenUsd = _readUsdPrice(tokenFeed, tokenMaxAge);
        uint256 bnbUsd = _readUsdPrice(bnbUsdFeed, bnbFeedMaxAge);
        uint256 tokenPriceMicros = (tokenUsd - 1) / 1e12 + 1;
        if (tokenPriceMicros == 0 || tokenPriceMicros > state.entryPriceMicros) revert OraclePriceAboveEntryLimit(tokenPriceMicros, state.entryPriceMicros);
        uint8 tokenDecimals = IERC20Decimals(trade.tokenOut).decimals();
        if (tokenDecimals > 18) revert InvalidOracleFeed(tokenFeed);
        uint256 tokenUnit = 10 ** uint256(tokenDecimals);
        uint256 numerator = trade.value * bnbUsd * tokenUnit;
        uint256 denominator = tokenUsd * PRICE_SCALE;
        // Round both stages upward: rounding down would silently grant extra
        // slippage against the owner-configured oracle floor.
        uint256 fairOut = (numerator + denominator - 1) / denominator;
        uint16 effectiveSlippageBps = trade.slippageBps < state.maxSlippageBps
            ? trade.slippageBps
            : state.maxSlippageBps;
        uint16 effectiveImpactBps = trade.maxPriceImpactBps < state.maxPriceImpactBps
            ? trade.maxPriceImpactBps
            : state.maxPriceImpactBps;
        uint16 effectiveToleranceBps = effectiveSlippageBps < effectiveImpactBps
            ? effectiveSlippageBps
            : effectiveImpactBps;
        uint256 toleratedOut = fairOut * (BPS_DENOMINATOR - effectiveToleranceBps);
        uint256 oracleMinimumOut = (toleratedOut + BPS_DENOMINATOR - 1) / BPS_DENOMINATOR;
        if (trade.amountOutMin < oracleMinimumOut) revert OraclePriceImpactExceeded(trade.amountOutMin, oracleMinimumOut);
    }

    function _readUsdPrice(address feed, uint32 maxAge) private view returns (uint256 price) {
        if (feed == address(0) || feed.code.length == 0 || maxAge == 0) revert InvalidOracleFeed(feed);
        uint8 feedDecimals = IChainlinkAggregatorV3(feed).decimals();
        if (feedDecimals > 18) revert InvalidOracleFeed(feed);
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = IChainlinkAggregatorV3(feed).latestRoundData();
        if (roundId == 0 || answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxAge || answeredInRound < roundId) revert OraclePriceUnavailable(feed);
        uint256 scale = 10 ** uint256(18 - feedDecimals);
        if (uint256(answer) > type(uint256).max / scale) revert OraclePriceUnavailable(feed);
        price = uint256(answer) * scale;
        if (price == 0 || price > 1e36) revert OraclePriceUnavailable(feed);
    }

    function _validateFeed(address feed, uint32 maxAge) private view {
        if (feed == address(0) || feed.code.length == 0) revert InvalidOracleFeed(feed);
        if (IChainlinkAggregatorV3(feed).decimals() > 18) revert InvalidOracleFeed(feed);
        _readUsdPrice(feed, maxAge);
    }

    function _hashTradeIntent(TradeIntent memory intent) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TRADE_INTENT_TYPEHASH,
                intent.smartAccount,
                intent.policyHash,
                intent.router,
                intent.tokenIn,
                intent.tokenOut,
                intent.recipient,
                intent.amountIn,
                intent.amountOutMin,
                intent.deadline,
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

    function _isPolicyManagementSelector(bytes4 selector) private pure returns (bool) {
        return selector == SET_ACCOUNT_POLICY_SELECTOR
            || selector == CLEAR_ACCOUNT_POLICY_SELECTOR
            || selector == REVOKE_ACCOUNT_SELECTOR;
    }

    function _selectorAt(bytes calldata data, uint256 offset) private pure returns (bytes4 selector) {
        assembly {
            selector := calldataload(add(data.offset, offset))
        }
    }
}
