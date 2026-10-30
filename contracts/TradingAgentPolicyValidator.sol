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
        if (msg.value != 0 || msgValue != 0) {
            revert UnexpectedHookValue(msg.value + msgValue);
        }

        AccountState storage state = accountStates[msg.sender];
        if (!state.installed) revert NotInitialized(msg.sender);
        if (state.revoked) revert AccountRevoked(msg.sender);

        (
            address target,
            uint256 value,
            bytes4 selector,
            address pathStart,
            address tokenOut,
            address recipient
        ) = _decodeTrade(msgData);
        if (target != approvedRouter) revert WrongTarget(target);
        if (selector != BUY_SELECTOR) revert UnsupportedSelector(selector);
        if (
            pathStart != wrappedNativeToken || tokenOut != state.targetToken
                || recipient != msg.sender
        ) {
            revert InvalidSwapRoute();
        }
        if (value == 0) revert ZeroTradeValue();
        if (value > MAX_TRADE_VALUE) {
            revert TradeValueTooHigh(value, MAX_TRADE_VALUE);
        }
        if (block.timestamp > type(uint64).max) revert TimestampOverflow();

        _expireTrades(state);
        uint256 attemptedVolume = state.rollingVolume + value;
        if (attemptedVolume > MAX_ROLLING_VOLUME) {
            revert RollingWindowCapExceeded(attemptedVolume, MAX_ROLLING_VOLUME);
        }
        if (state.tail - state.head >= MAX_ACTIVE_TRADES) {
            revert TooManyActiveTrades(MAX_ACTIVE_TRADES);
        }

        state.trades[state.tail % MAX_ACTIVE_TRADES] =
            Trade({timestamp: uint64(block.timestamp), value: uint192(value)});
        state.tail += 1;
        state.rollingVolume = attemptedVolume;
        emit AgentExecutionAttempt(msg.sender, state.targetToken, value, block.timestamp);
        return abi.encode(state.targetToken, value);
    }

    function postCheck(bytes calldata hookData) external payable {
        if (hookData.length != 64) revert InvalidHookData();
        AccountState storage state = accountStates[msg.sender];
        if (!state.installed) {
            revert NotInitialized(msg.sender);
        }
        (address targetToken, uint256 value) = abi.decode(hookData, (address, uint256));
        if (targetToken != state.targetToken || value == 0) revert InvalidHookData();
        emit AgentExecutionSucceeded(msg.sender, targetToken, value, block.timestamp);
    }

    function getRollingVolume(address account) external view returns (uint256) {
        return accountStates[account].rollingVolume;
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
        returns (
            address target,
            uint256 value,
            bytes4 selector,
            address pathStart,
            address tokenOut,
            address recipient
        )
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
        if (dataLength < 52 + 228) revert InvalidExecutionCalldata();

        bytes calldata execution = args[96:96 + dataLength];
        assembly {
            target := shr(96, calldataload(execution.offset))
            value := calldataload(add(execution.offset, 20))
            selector := calldataload(add(execution.offset, 52))
        }

        bytes calldata routerCall = execution[52:];
        if (selector != BUY_SELECTOR) return (target, value, selector, address(0), address(0), address(0));
        if (routerCall.length != 228) revert InvalidSwapRoute();
        uint256 pathOffset;
        uint256 pathLength;
        uint256 amountOutMin;
        assembly {
            amountOutMin := calldataload(add(routerCall.offset, 4))
            pathOffset := calldataload(add(routerCall.offset, 36))
            recipient := and(
                calldataload(add(routerCall.offset, 68)),
                0xffffffffffffffffffffffffffffffffffffffff
            )
        }
        if (amountOutMin == 0 || pathOffset != 128) revert InvalidSwapRoute();
        assembly {
            pathLength := calldataload(add(routerCall.offset, 132))
            pathStart := and(
                calldataload(add(routerCall.offset, 164)),
                0xffffffffffffffffffffffffffffffffffffffff
            )
            tokenOut := and(
                calldataload(add(routerCall.offset, 196)),
                0xffffffffffffffffffffffffffffffffffffffff
            )
        }
        if (pathLength != 2) revert InvalidSwapRoute();
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
