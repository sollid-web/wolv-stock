// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../contracts/TradingAgentPolicyValidator.sol";

interface Vm {
    function chainId(uint256 newChainId) external;
    function addr(uint256 privateKey) external returns (address);
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter)
        external;
    function expectPartialRevert(bytes4 revertData) external;
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
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
    uint256 private constant INTENT_SIGNER_PRIVATE_KEY = 0xA11CE;
    bytes32 private constant POLICY_HASH = keccak256("WOLV-POLICY-V1");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant EIP712_NAME_HASH = keccak256("WolvTradingAgent");
    bytes32 private constant EIP712_VERSION_HASH = keccak256("1");
    bytes32 private constant TRADE_INTENT_TYPEHASH = keccak256(
        "TradeIntent(address smartAccount,bytes32 policyHash,address router,address tokenIn,address tokenOut,address recipient,uint256 amountIn,uint256 amountOutMin,uint64 deadline,uint16 slippageBps,uint16 maxPriceImpactBps,uint64 validUntil,bytes32 nonce)"
    );
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
    MockFactory private factory;
    MockRouter private router;
    MockEntryPoint private entryPoint;
    TradingAgentPolicyValidator private hook;
    MockToken private targetToken;
    address private intentSigner;
    uint256 private intentNonce;
    bytes32 private lastIntentNonce;

    function setUp() public {
        vm.chainId(56);
        intentSigner = vm.addr(INTENT_SIGNER_PRIVATE_KEY);
        factory = new MockFactory();
        router = new MockRouter(address(factory));
        entryPoint = new MockEntryPoint();
        targetToken = new MockToken();
        hook = new TradingAgentPolicyValidator(address(router), address(entryPoint));
        vm.prank(SMART_ACCOUNT);
        hook.onInstall(abi.encodePacked(bytes1(0), abi.encode(address(targetToken))));
        vm.prank(SMART_ACCOUNT);
        hook.setAccountPolicy(
            SMART_ACCOUNT,
            intentSigner,
            POLICY_HASH,
            0.5 ether,
            uint64(block.timestamp + 365 days)
        );
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
        hook.onInstall(abi.encodePacked(bytes1(0), abi.encode(address(targetToken))));
        vm.prank(OTHER_ACCOUNT);
        hook.setAccountPolicy(
            OTHER_ACCOUNT,
            intentSigner,
            POLICY_HASH,
            0.5 ether,
            uint64(block.timestamp + 365 days)
        );
        _check(OTHER_ACCOUNT, address(entryPoint), 0.5 ether, BUY_SELECTOR);

        require(hook.getRollingVolume(SMART_ACCOUNT) == 0.5 ether);
        require(hook.getRollingVolume(OTHER_ACCOUNT) == 0.5 ether);
    }

    function testRejectsSellSelector() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.UnsupportedSelector.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether, SELL_SELECTOR);
    }

    function testSmartAccountCanConfigureAndClearItsPolicy() public {
        bytes32 policyHash = keccak256("WOLV-POLICY-V1");
        uint64 expiresAt = uint64(block.timestamp + 1 hours);
        vm.prank(SMART_ACCOUNT);
        hook.setAccountPolicy(SMART_ACCOUNT, intentSigner, policyHash, 0.25 ether, expiresAt);

        (bool configured, bytes32 storedHash, uint192 maxTrade, uint64 storedExpiry, address storedSigner) =
            hook.getAccountPolicy(SMART_ACCOUNT);
        require(configured);
        require(storedHash == policyHash);
        require(maxTrade == 0.25 ether);
        require(storedExpiry == expiresAt);
        require(storedSigner == intentSigner);

        vm.expectPartialRevert(TradingAgentPolicyValidator.TradeValueTooHigh.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0.25 ether + 1, BUY_SELECTOR);

        vm.prank(SMART_ACCOUNT);
        hook.clearAccountPolicy(SMART_ACCOUNT);
        (configured, storedHash, maxTrade, storedExpiry, storedSigner) =
            hook.getAccountPolicy(SMART_ACCOUNT);
        require(!configured);
        require(storedHash == bytes32(0));
        require(maxTrade == 0);
        require(storedExpiry == 0);
        require(storedSigner == address(0));
        vm.expectPartialRevert(TradingAgentPolicyValidator.PolicyNotConfigured.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0.25 ether, BUY_SELECTOR);
    }

    function testConfiguredPolicyEnforcesExpiryAndTradeCap() public {
        vm.prank(SMART_ACCOUNT);
        hook.setAccountPolicy(
            SMART_ACCOUNT,
            intentSigner,
            keccak256("WOLV-POLICY-V1"),
            0.1 ether,
            uint64(block.timestamp + 1 hours)
        );
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether, BUY_SELECTOR);

        vm.expectPartialRevert(TradingAgentPolicyValidator.TradeValueTooHigh.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether + 1, BUY_SELECTOR);

        vm.warp(block.timestamp + 1 hours);
        vm.expectPartialRevert(TradingAgentPolicyValidator.PolicyExpired.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether, BUY_SELECTOR);
    }

    function testPolicyConfigurationRejectsInvalidValuesAndNonAccount() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.PolicyHashInvalid.selector);
        vm.prank(SMART_ACCOUNT);
        hook.setAccountPolicy(SMART_ACCOUNT, intentSigner, bytes32(0), 0.1 ether, uint64(block.timestamp + 1 hours));

        vm.expectPartialRevert(TradingAgentPolicyValidator.PolicyTradeCapInvalid.selector);
        vm.prank(SMART_ACCOUNT);
        hook.setAccountPolicy(SMART_ACCOUNT, intentSigner, keccak256("WOLV-POLICY-V1"), 0, uint64(block.timestamp + 1 hours));

        vm.expectPartialRevert(TradingAgentPolicyValidator.PolicyExpiryInvalid.selector);
        vm.prank(SMART_ACCOUNT);
        hook.setAccountPolicy(SMART_ACCOUNT, intentSigner, keccak256("WOLV-POLICY-V1"), 0.1 ether, uint64(block.timestamp));

        vm.expectPartialRevert(TradingAgentPolicyValidator.OnlySmartAccount.selector);
        hook.setAccountPolicy(SMART_ACCOUNT, intentSigner, keccak256("WOLV-POLICY-V1"), 0.1 ether, uint64(block.timestamp + 1 hours));

        vm.expectPartialRevert(TradingAgentPolicyValidator.OnlySmartAccount.selector);
        hook.clearAccountPolicy(SMART_ACCOUNT);

        vm.expectPartialRevert(TradingAgentPolicyValidator.PolicyIntentSignerInvalid.selector);
        vm.prank(SMART_ACCOUNT);
        hook.setAccountPolicy(SMART_ACCOUNT, address(0), keccak256("WOLV-POLICY-V1"), 0.1 ether, uint64(block.timestamp + 1 hours));
    }

    function testPolicyManagementCallsPassThroughTheExecutionHook() public {
        bytes memory policyCall = abi.encodeWithSelector(
            hook.setAccountPolicy.selector,
            SMART_ACCOUNT,
            intentSigner,
            keccak256("WOLV-POLICY-V2"),
            0.25 ether,
            uint64(block.timestamp + 1 hours)
        );
        bytes memory execution = abi.encodePacked(address(hook), bytes32(0), policyCall);
        bytes memory callData = abi.encodeWithSelector(EXECUTE_SELECTOR, bytes32(0), execution);
        vm.prank(SMART_ACCOUNT);
        bytes memory hookData = hook.preCheck(address(entryPoint), 0, callData);
        require(hookData.length == 0);

        vm.prank(SMART_ACCOUNT);
        hook.postCheck(hookData);

        vm.prank(SMART_ACCOUNT);
        hook.setAccountPolicy(
            SMART_ACCOUNT,
            intentSigner,
            keccak256("WOLV-POLICY-V2"),
            0.25 ether,
            uint64(block.timestamp + 1 hours)
        );
        (bool configured, bytes32 storedHash, uint192 maxTrade,,) =
            hook.getAccountPolicy(SMART_ACCOUNT);
        require(configured);
        require(storedHash == keccak256("WOLV-POLICY-V2"));
        require(maxTrade == 0.25 ether);
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

    function testGuardianPauseAndAccountRevocationHaveSeparateAuthority() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.OnlyGuardian.selector);
        vm.prank(SMART_ACCOUNT);
        hook.setPaused(true);

        vm.expectPartialRevert(TradingAgentPolicyValidator.OnlySmartAccount.selector);
        vm.prank(OTHER_ACCOUNT);
        hook.revokeAccount(SMART_ACCOUNT);
    }

    function testSmartAccountCanImmediatelyRevokeUntilReinstalled() public {
        vm.prank(SMART_ACCOUNT);
        hook.revokeAccount(SMART_ACCOUNT);
        vm.expectPartialRevert(TradingAgentPolicyValidator.AccountRevoked.selector);
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether, BUY_SELECTOR);

        vm.prank(SMART_ACCOUNT);
        hook.onUninstall(bytes(""));
        vm.prank(SMART_ACCOUNT);
        hook.onInstall(abi.encodePacked(bytes1(0), abi.encode(address(targetToken))));
        _check(SMART_ACCOUNT, address(entryPoint), 0.1 ether, BUY_SELECTOR);
    }

    function testExecutionEventsAreEmittedOnlyForSuccessfulHookLifecycle() public {
        vm.expectEmit(true, true, false, true, address(hook));
        emit AgentExecutionAttempt(SMART_ACCOUNT, address(targetToken), 0.1 ether, block.timestamp);
        bytes memory callData = _encodeCall(
            SMART_ACCOUNT,
            address(router),
            0.1 ether,
            BUY_SELECTOR
        );
        vm.prank(SMART_ACCOUNT);
        bytes memory hookData = hook.preCheck(address(entryPoint), 0, callData);

        vm.expectEmit(true, true, false, true, address(hook));
        emit AgentExecutionSucceeded(SMART_ACCOUNT, address(targetToken), 0.1 ether, block.timestamp);
        vm.prank(SMART_ACCOUNT);
        hook.postCheck(hookData);
        require(hook.isIntentNonceConsumed(SMART_ACCOUNT, lastIntentNonce));
    }

    function testRejectsReplayedOnchainIntentNonce() public {
        bytes memory callData = _encodeCall(SMART_ACCOUNT, address(router), 0.1 ether, BUY_SELECTOR);
        vm.prank(SMART_ACCOUNT);
        hook.preCheck(address(entryPoint), 0, callData);

        vm.expectPartialRevert(TradingAgentPolicyValidator.PolicyIntentReplay.selector);
        vm.prank(SMART_ACCOUNT);
        hook.preCheck(address(entryPoint), 0, callData);
    }

    function testRejectsTamperedPolicyBindingAndSignature() public {
        bytes memory policyTamperedCall = _encodeCall(
            SMART_ACCOUNT,
            address(router),
            0.1 ether,
            BUY_SELECTOR
        );
        policyTamperedCall[380] = bytes1(uint8(policyTamperedCall[380]) ^ 1);
        vm.expectPartialRevert(TradingAgentPolicyValidator.PolicyIntentHashMismatch.selector);
        vm.prank(SMART_ACCOUNT);
        hook.preCheck(address(entryPoint), 0, policyTamperedCall);

        bytes memory signatureTamperedCall = _encodeCall(
            SMART_ACCOUNT,
            address(router),
            0.1 ether,
            BUY_SELECTOR
        );
        signatureTamperedCall[604] = bytes1(uint8(signatureTamperedCall[604]) ^ 1);
        vm.expectPartialRevert(TradingAgentPolicyValidator.PolicyIntentSignatureInvalid.selector);
        vm.prank(SMART_ACCOUNT);
        hook.preCheck(address(entryPoint), 0, signatureTamperedCall);
    }

    function testRejectsTradeParametersNotBoundBySignature() public {
        bytes memory callData = _encodeCall(SMART_ACCOUNT, address(router), 0.1 ether, BUY_SELECTOR);
        callData[187] = bytes1(0x02);
        vm.expectPartialRevert(TradingAgentPolicyValidator.PolicyIntentSignatureInvalid.selector);
        vm.prank(SMART_ACCOUNT);
        hook.preCheck(address(entryPoint), 0, callData);
    }

    function testRejectsExpiredIntentEnvelope() public {
        bytes memory callData = _encodeCall(SMART_ACCOUNT, address(router), 0.1 ether, BUY_SELECTOR);
        uint64 expiredAt = uint64(block.timestamp - 1);
        assembly {
            mstore(add(add(callData, 32), 444), expiredAt)
        }
        vm.expectPartialRevert(TradingAgentPolicyValidator.PolicyIntentExpired.selector);
        vm.prank(SMART_ACCOUNT);
        hook.preCheck(address(entryPoint), 0, callData);
    }

    function testRejectsExpiredRouterDeadline() public {
        bytes memory callData = _encodeCall(SMART_ACCOUNT, address(router), 0.1 ether, BUY_SELECTOR);
        uint64 expiredDeadline = uint64(block.timestamp);
        assembly {
            mstore(add(add(callData, 32), 252), expiredDeadline)
        }
        vm.expectPartialRevert(TradingAgentPolicyValidator.SwapDeadlineInvalid.selector);
        vm.prank(SMART_ACCOUNT);
        hook.preCheck(address(entryPoint), 0, callData);
    }

    function testRejectsInstallPayloadWithoutKernelHookPrefix() public {
        vm.expectPartialRevert(TradingAgentPolicyValidator.InvalidHookData.selector);
        vm.prank(OTHER_ACCOUNT);
        hook.onInstall(abi.encode(address(targetToken)));
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
        bytes memory callData = _encodeCall(account, target, value, selector);
        vm.prank(account);
        hook.preCheck(msgSender, 0, callData);
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
        bytes memory callData = _encodeCall(
            account,
            address(router),
            0.1 ether,
            BUY_SELECTOR,
            tokenOut,
            recipient,
            1,
            pathStart
        );
        vm.prank(account);
        hook.preCheck(msgSender, 0, callData);
    }

    function _encodeCall(address account, address target, uint256 value, bytes4 selector)
        private
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
    ) private returns (bytes memory) {
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
        address account,
        address target,
        uint256 value,
        bytes4 selector,
        address tokenOut,
        address recipient,
        uint256 minimumOutput,
        address pathStart
    ) private returns (bytes memory) {
        uint64 deadline = uint64(block.timestamp + hook.MAX_SWAP_DEADLINE_SECONDS());
        bytes memory execution = _encodeExecution(
            pathStart,
            target,
            value,
            selector,
            tokenOut,
            recipient,
            minimumOutput,
            deadline
        );
        if (selector == BUY_SELECTOR) {
            execution = abi.encodePacked(
                execution,
                _encodeIntentEnvelope(
                    account,
                    target,
                    pathStart,
                    value,
                    tokenOut,
                    recipient,
                    minimumOutput,
                    deadline
                )
            );
        }
        return abi.encodeWithSelector(
            EXECUTE_SELECTOR,
            bytes32(0),
            execution
        );
    }

    function _encodeIntentEnvelope(
        address account,
        address routerAddress,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        address recipient,
        uint256 amountOutMin,
        uint64 deadline
    ) private returns (bytes memory) {
        bytes32 nonce = keccak256(abi.encode(++intentNonce, account, block.timestamp));
        lastIntentNonce = nonce;
        uint64 validUntil = uint64(block.timestamp + 1 hours);
        TradingAgentPolicyValidator.TradeIntent memory intent =
            TradingAgentPolicyValidator.TradeIntent({
                smartAccount: account,
                policyHash: POLICY_HASH,
                router: routerAddress,
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMin: amountOutMin,
                deadline: deadline,
                slippageBps: 100,
                maxPriceImpactBps: 300,
                validUntil: validUntil,
                nonce: nonce
            });
        bytes32 digest = _hashTradeIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(INTENT_SIGNER_PRIVATE_KEY, digest);
        return abi.encode(
            POLICY_HASH,
            nonce,
            validUntil,
            uint16(100),
            uint16(300),
            abi.encodePacked(r, s, v)
        );
    }

    function _hashTradeIntent(TradingAgentPolicyValidator.TradeIntent memory intent)
        private
        view
        returns (bytes32)
    {
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
                address(hook)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
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
        return _encodeExecution(
            pathStart,
            target,
            value,
            selector,
            tokenOut,
            recipient,
            minimumOutput,
            uint64(block.timestamp + hook.MAX_SWAP_DEADLINE_SECONDS())
        );
    }

    function _encodeExecution(
        address pathStart,
        address target,
        uint256 value,
        bytes4 selector,
        address tokenOut,
        address recipient,
        uint256 minimumOutput,
        uint64 deadline
    ) private pure returns (bytes memory) {
        address[] memory path = new address[](2);
        path[0] = pathStart;
        path[1] = tokenOut;
        bytes memory routerCall =
            abi.encodeWithSelector(selector, minimumOutput, path, recipient, deadline);
        return abi.encodePacked(target, bytes32(value), routerCall);
    }
}
