// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../contracts/TradingAgentPolicyValidator.sol";

interface Vm {
    function chainId(uint256 newChainId) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter)
        external;
    function expectPartialRevert(bytes4 revertData) external;
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

contract MockFactory {}

contract MockRouter {
    address private immutable factoryAddress;

    constructor(address factoryAddress_) {
        factoryAddress = factoryAddress_;
    }

    function factory() external view returns (address) {
        return factoryAddress;
    }
}

contract MockEntryPoint {}

contract MockToken {}

contract TradingAgentPolicyValidatorTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant SMART_ACCOUNT = address(0xA11CE);
    address private constant OTHER_ACCOUNT = address(0xB0B);
    bytes4 private constant BUY_SELECTOR = 0x7ff36ab5;
    bytes4 private constant SELL_SELECTOR = 0x18cbafe5;
    bytes4 private constant EXECUTE_SELECTOR = bytes4(keccak256("execute(bytes32,bytes)"));
    address private constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

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

    MockFactory private factory;
    MockRouter private router;
    MockEntryPoint private entryPoint;
    TradingAgentPolicyValidator private hook;
    MockToken private targetToken;

    function setUp() public {
        vm.chainId(56);
        factory = new MockFactory();
        router = new MockRouter(address(factory));
        entryPoint = new MockEntryPoint();
        targetToken = new MockToken();
        hook = new TradingAgentPolicyValidator(address(router), address(entryPoint));
        vm.prank(SMART_ACCOUNT);
        hook.onInstall(abi.encode(address(targetToken)));
        require(hook.getTargetToken(SMART_ACCOUNT) == address(targetToken));
    }

    function testAllowsTradeAtPerTradeLimit() public {
        _check(SMART_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);

        require(hook.getRollingVolume(SMART_ACCOUNT) == 0.5 ether);
        require(hook.getActiveTradeCount(SMART_ACCOUNT) == 1);
    }

    function testRejectsTradeAbovePerTradeLimit() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.TradeValueTooHigh.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0.5 ether + 1, BUY_SELECTOR);
        require(hook.getRollingVolume(SMART_ACCOUNT) == 0);
    }

    function testRejectsCumulativeVolumeAboveRollingLimit() public {
        _check(SMART_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);
        _check(SMART_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);

        vm.expectPartialRevert(TradingAgentPolicyValidator.RollingWindowCapExceeded.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 1, BUY_SELECTOR);
        require(hook.getRollingVolume(SMART_ACCOUNT) == 1 ether);
    }

    function testExpiresTradeAtExactSevenDayBoundary() public {
        uint256 startedAt = block.timestamp;
        _check(SMART_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);
        _check(SMART_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);

        vm.warp(startedAt + 604_799);
        vm.expectPartialRevert(TradingAgentPolicyValidator.RollingWindowCapExceeded.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);

        vm.warp(startedAt + 604_800);
        _check(SMART_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);
        require(hook.getRollingVolume(SMART_ACCOUNT) == 0.5 ether);
        require(hook.getActiveTradeCount(SMART_ACCOUNT) == 1);
    }

    function testEffectiveRollingVolumeExcludesExpiredTradesBeforeNextExecution() public {
        _check(SMART_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);
        require(hook.getEffectiveRollingVolume(SMART_ACCOUNT) == 0.5 ether);

        vm.warp(block.timestamp + 604_800);
        require(hook.getRollingVolume(SMART_ACCOUNT) == 0.5 ether);
        require(hook.getEffectiveRollingVolume(SMART_ACCOUNT) == 0);
    }

    function testRollingWindowExpiresOnlyMatureTrade() public {
        uint256 startedAt = block.timestamp;
        _check(SMART_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);

        vm.warp(startedAt + 1 days);
        _check(SMART_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);

        vm.warp(startedAt + 604_800);
        _check(SMART_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);
        require(hook.getRollingVolume(SMART_ACCOUNT) == 1 ether);
        require(hook.getActiveTradeCount(SMART_ACCOUNT) == 2);
    }

    function testVolumeIsTrackedPerSmartAccount() public {
        _check(SMART_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);
        vm.prank(OTHER_ACCOUNT);
        hook.onInstall(abi.encode(address(targetToken)));
        _check(OTHER_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);

        require(hook.getRollingVolume(SMART_ACCOUNT) == 0.5 ether);
        require(hook.getRollingVolume(OTHER_ACCOUNT) == 0.5 ether);
    }

    function testRejectsSellSelector() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.UnsupportedSelector.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether, SELL_SELECTOR);
    }

    function testRejectsWrongRouter() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.WrongTarget.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether, BUY_SELECTOR, address(0x9999));
    }

    function testRejectsBatchExecutionMode() public {
        bytes memory callData = abi.encodeWithSelector(
            EXECUTE_SELECTOR,
            bytes32(uint256(1) << 248),
            _encodeExecution(SMART_ACCOUNT, address(router), 0.1 ether, BUY_SELECTOR)
        );

        vm.expectPartialRevert(TradingAgentPolicyValidator.UnsupportedExecutionMode.selector);
        vm.prank(SMART_ACCOUNT);
        hook.preCheck(address(entryPoint), 0, callData);
    }

    function testRejectsUninitializedAccount() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.NotInitialized.selector);
        _check(OTHER_ACCOUNT, address(entryPoint), 0.1 ether, BUY_SELECTOR);
    }

    function testRejectsNonEntryPointExecution() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.OnlyEntryPoint.selector);
        _check(SMART_ACCOUNT, address(0xBAD), 0.1 ether, BUY_SELECTOR);
    }

    function testRejectsZeroValueTrade() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.ZeroTradeValue.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0, BUY_SELECTOR);
    }

    function testBoundsActiveTradeQueue() public {
        for (uint256 i = 0; i < hook.MAX_ACTIVE_TRADES(); i++) {
            _check(SMART_ACCOUNT, address(entryPoint), 1, BUY_SELECTOR);
        }

        vm.expectPartialRevert(TradingAgentPolicyValidator.TooManyActiveTrades.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 1, BUY_SELECTOR);
    }

    function testUninstallDisablesHookButRetainsWindowState() public {
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether, BUY_SELECTOR);
        vm.prank(SMART_ACCOUNT);
        hook.onUninstall(bytes(""));

        require(!hook.isInitialized(SMART_ACCOUNT));
        require(hook.getTargetToken(SMART_ACCOUNT) == address(0));
        require(hook.getRollingVolume(SMART_ACCOUNT) == 0.1 ether);

        vm.expectPartialRevert(TradingAgentPolicyValidator.NotInitialized.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether, BUY_SELECTOR);
    }

    function testConstructorSupportsOnlyBscNetworksAndDeployedRouter() public {
        vm.chainId(97);
        TradingAgentPolicyValidator testnetHook = new TradingAgentPolicyValidator(address(router), address(entryPoint));
        require(testnetHook.deploymentChainId() == 97);

        vm.chainId(1);
        vm.expectPartialRevert(TradingAgentPolicyValidator.UnsupportedChain.selector);
        new TradingAgentPolicyValidator(address(router), address(entryPoint));
    }

    function testIdentifiesAsErc7579HookModule() public view {
        require(hook.isModuleType(4));
        require(!hook.isModuleType(1));
    }

    function testRejectsWrongOutputToken() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.InvalidSwapRoute.selector);
        _checkWithRoute(SMART_ACCOUNT, address(entryPoint), address(0xBEEF), SMART_ACCOUNT);
    }

    function testRejectsWrongRecipient() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.InvalidSwapRoute.selector);
        _checkWithRoute(SMART_ACCOUNT, address(entryPoint), address(targetToken), address(0xBEEF));
    }

    function testRejectsNonWrappedNativeFirstHop() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.InvalidSwapRoute.selector);
        _checkWithRoute(
            SMART_ACCOUNT,
            address(entryPoint),
            address(targetToken),
            SMART_ACCOUNT,
            address(0xCAFE)
        );
    }

    function testGuardianCanPauseAndResumeExecution() public {
        hook.setPaused(true);
        require(hook.paused());
        vm.expectPartialRevert(TradingAgentPolicyValidator.AgentPaused.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether, BUY_SELECTOR);

        hook.setPaused(false);
        require(!hook.paused());
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether, BUY_SELECTOR);
    }

    function testNonGuardianCannotPauseOrRevoke() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.OnlyGuardian.selector);
        vm.prank(SMART_ACCOUNT);
        hook.setPaused(true);

        vm.expectPartialRevert(TradingAgentPolicyValidator.OnlyGuardian.selector);
        vm.prank(SMART_ACCOUNT);
        hook.revokeAccount(SMART_ACCOUNT);
    }

    function testGuardianCanImmediatelyRevokeAccountUntilReinstalled() public {
        hook.revokeAccount(SMART_ACCOUNT);
        vm.expectPartialRevert(TradingAgentPolicyValidator.AccountRevoked.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether, BUY_SELECTOR);

        vm.prank(SMART_ACCOUNT);
        hook.onUninstall(bytes(""));
        vm.prank(SMART_ACCOUNT);
        hook.onInstall(abi.encode(address(targetToken)));
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether, BUY_SELECTOR);
    }

    function testExecutionEventsAreEmittedOnlyForSuccessfulHookLifecycle() public {
        vm.expectEmit(true, true, false, true, address(hook));
        emit AgentExecutionAttempt(SMART_ACCOUNT, address(targetToken), 0.1 ether, block.timestamp);
        vm.prank(SMART_ACCOUNT);
        bytes memory hookData = hook.preCheck(
            address(entryPoint),
            0,
            _encodeCall(SMART_ACCOUNT, address(router), 0.1 ether, BUY_SELECTOR)
        );

        vm.expectEmit(true, true, false, true, address(hook));
        emit AgentExecutionSucceeded(SMART_ACCOUNT, address(targetToken), 0.1 ether, block.timestamp);
        vm.prank(SMART_ACCOUNT);
        hook.postCheck(hookData);
    }

    function testGuardianCanRecordRejectedPolicyTelemetry() public {
        bytes32 reasonCode = keccak256("PRICE_IMPACT_EXCEEDED");
        bytes32 contextHash = keccak256("test-context");
        vm.expectEmit(true, true, false, true, address(hook));
        emit PolicyViolationRejected(SMART_ACCOUNT, reasonCode, contextHash, block.timestamp);
        hook.recordPolicyViolation(SMART_ACCOUNT, reasonCode, contextHash);

        vm.expectPartialRevert(TradingAgentPolicyValidator.OnlyGuardian.selector);
        vm.prank(SMART_ACCOUNT);
        hook.recordPolicyViolation(SMART_ACCOUNT, reasonCode, contextHash);
    }

    function testRejectsZeroMinimumOutput() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.InvalidSwapRoute.selector);
        vm.prank(SMART_ACCOUNT);
        hook.preCheck(
            address(entryPoint),
            0,
            _encodeCall(
                SMART_ACCOUNT,
                address(router),
                0.1 ether,
                BUY_SELECTOR,
                address(targetToken),
                SMART_ACCOUNT,
                0
            )
        );
    }

    function _check(address account, address msgSender, uint256 value, bytes4 selector) private {
        _check(account, msgSender, value, selector, address(router));
    }

    function _check(address account, address msgSender, uint256 value, bytes4 selector, address target) private {
        vm.prank(account);
        hook.preCheck(msgSender, 0, _encodeCall(account, target, value, selector));
    }

    function _checkWithRoute(
        address account,
        address msgSender,
        address tokenOut,
        address recipient
    ) private {
        _checkWithRoute(account, msgSender, tokenOut, recipient, WBNB);
    }

    function _checkWithRoute(
        address account,
        address msgSender,
        address tokenOut,
        address recipient,
        address pathStart
    ) private {
        vm.prank(account);
        hook.preCheck(
            msgSender,
            0,
            _encodeCall(
                account,
                address(router),
                0.1 ether,
                BUY_SELECTOR,
                tokenOut,
                recipient,
                1,
                pathStart
            )
        );
    }

    function _encodeCall(address account, address target, uint256 value, bytes4 selector)
        private
        view
        returns (bytes memory)
    {
        return _encodeCall(account, target, value, selector, address(targetToken), account, 1);
    }

    function _encodeCall(
        address account,
        address target,
        uint256 value,
        bytes4 selector,
        address tokenOut,
        address recipient,
        uint256 minimumOutput
    ) private view returns (bytes memory) {
        return _encodeCall(
            account,
            target,
            value,
            selector,
            tokenOut,
            recipient,
            minimumOutput,
            WBNB
        );
    }

    function _encodeCall(
        address,
        address target,
        uint256 value,
        bytes4 selector,
        address tokenOut,
        address recipient,
        uint256 minimumOutput,
        address pathStart
    ) private view returns (bytes memory) {
        return abi.encodeWithSelector(
            EXECUTE_SELECTOR,
            bytes32(0),
            _encodeExecution(
                pathStart,
                target,
                value,
                selector,
                tokenOut,
                recipient,
                minimumOutput
            )
        );
    }

    function _encodeExecution(
        address account,
        address target,
        uint256 value,
        bytes4 selector
    ) private view returns (bytes memory) {
        return _encodeExecution(
            WBNB,
            target,
            value,
            selector,
            address(targetToken),
            account,
            1
        );
    }

    function _encodeExecution(
        address pathStart,
        address target,
        uint256 value,
        bytes4 selector,
        address tokenOut,
        address recipient,
        uint256 minimumOutput
    ) private view returns (bytes memory) {
        address[] memory path = new address[](2);
        path[0] = pathStart;
        path[1] = tokenOut;
        bytes memory routerCall =
            abi.encodeWithSelector(selector, minimumOutput, path, recipient, block.timestamp + 300);
        return abi.encodePacked(target, bytes32(value), routerCall);
    }
}
