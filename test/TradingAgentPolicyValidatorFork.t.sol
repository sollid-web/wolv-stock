// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../contracts/TradingAgentPolicyValidator.sol";

interface VmFork {
    function addr(uint256 privateKey) external returns (address);
    function createSelectFork(string calldata rpcUrl) external returns (uint256);
    function deal(address account, uint256 newBalance) external;
    function envString(string calldata name) external returns (string memory);
    function expectPartialRevert(bytes4 revertData) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
}

interface IERC20Fork {
    function balanceOf(address account) external view returns (uint256);
}

contract MockForkEntryPoint {}

contract MockForkKernelAccount {
    TradingAgentPolicyValidator private immutable hook;
    address private immutable entryPoint;
    uint256 public lastPreCheckGasUsed;

    constructor(TradingAgentPolicyValidator hook_, address entryPoint_) {
        hook = hook_;
        entryPoint = entryPoint_;
    }

    function install(address targetToken) external {
        hook.onInstall(abi.encodePacked(bytes1(0), abi.encode(targetToken)));
    }

    function configurePolicy(
        address intentSigner,
        bytes32 policyHash,
        uint192 maxTradeValue,
        uint64 expiresAt
    ) external {
        hook.setAccountPolicy(
            address(this),
            intentSigner,
            policyHash,
            maxTradeValue,
            expiresAt
        );
    }

    function execute(bytes calldata kernelCallData) external returns (bytes memory result) {
        uint256 gasBeforePreCheck = gasleft();
        bytes memory hookData = hook.preCheck(entryPoint, 0, kernelCallData);
        lastPreCheckGasUsed = gasBeforePreCheck - gasleft();
        (bytes32 mode, bytes memory execution) =
            abi.decode(kernelCallData[4:], (bytes32, bytes));
        require(mode == bytes32(0), "unsupported mode");
        require(execution.length >= 52, "invalid execution");

        address target;
        uint256 value;
        assembly {
            target := shr(96, mload(add(execution, 32)))
            value := mload(add(execution, 52))
        }
        bytes memory payload = new bytes(execution.length - 52);
        for (uint256 index; index < payload.length; index++) {
            payload[index] = execution[index + 52];
        }

        (bool success, bytes memory returnData) = target.call{value: value}(payload);
        if (!success) {
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }
        hook.postCheck(hookData);
        return returnData;
    }
}

contract TradingAgentPolicyValidatorForkTest {
    VmFork private constant vm =
        VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant INTENT_SIGNER_PRIVATE_KEY = 0xBEEF;
    bytes32 private constant POLICY_HASH = keccak256("WOLV-FORK-POLICY-V1");
    bytes4 private constant EXECUTE_SELECTOR = bytes4(keccak256("execute(bytes32,bytes)"));
    bytes4 private constant BUY_SELECTOR = 0x7ff36ab5;
    address private constant ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address private constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address private constant USDT = 0x55d398326f99059fF775485246999027B3197955;

    event HookPreCheckGasMeasured(uint256 gasUsed);

    MockForkEntryPoint private entryPoint;
    TradingAgentPolicyValidator private hook;
    MockForkKernelAccount private account;
    address private intentSigner;
    uint256 private nonce;

    function setUp() public {
        vm.createSelectFork(vm.envString("BSC_MAINNET_RPC_URL"));
        require(block.chainid == 56, "expected BSC mainnet fork");

        entryPoint = new MockForkEntryPoint();
        hook = new TradingAgentPolicyValidator(ROUTER, address(entryPoint));
        account = new MockForkKernelAccount(hook, address(entryPoint));
        intentSigner = vm.addr(INTENT_SIGNER_PRIVATE_KEY);
        account.install(USDT);
        account.configurePolicy(
            intentSigner,
            POLICY_HASH,
            uint192(hook.MAX_TRADE_VALUE()),
            uint64(block.timestamp + 1 days)
        );
    }

    function testExecutesAuthorizedSwapThroughActualRouter() public {
        vm.deal(address(account), 1 ether);
        bytes memory callData = _buildCall(
            0.001 ether,
            1,
            address(account),
            uint64(block.timestamp + hook.MAX_SWAP_DEADLINE_SECONDS())
        );

        uint256 previousBalance = IERC20Fork(USDT).balanceOf(address(account));
        account.execute(callData);
        require(IERC20Fork(USDT).balanceOf(address(account)) > previousBalance, "swap returned no tokens");
        require(account.lastPreCheckGasUsed() < 150_000, "hook validation exceeded gas budget");
        emit HookPreCheckGasMeasured(account.lastPreCheckGasUsed());
    }

    function testRejectsExpiredDeadlineOnFork() public {
        bytes memory callData = _buildCall(0.001 ether, 1, address(account), uint64(block.timestamp));

        vm.expectPartialRevert(TradingAgentPolicyValidator.SwapDeadlineInvalid.selector);
        account.execute(callData);
    }

    function testRejectsReplayAgainstForkRouter() public {
        vm.deal(address(account), 1 ether);
        bytes memory callData = _buildCall(
            0.001 ether,
            1,
            address(account),
            uint64(block.timestamp + hook.MAX_SWAP_DEADLINE_SECONDS())
        );
        account.execute(callData);

        vm.expectPartialRevert(TradingAgentPolicyValidator.PolicyIntentReplay.selector);
        account.execute(callData);
    }

    function testRejectsAlteredRecipientOnFork() public {
        bytes memory callData = _buildCall(
            0.001 ether,
            1,
            address(0xBEEF),
            uint64(block.timestamp + hook.MAX_SWAP_DEADLINE_SECONDS())
        );

        vm.expectPartialRevert(TradingAgentPolicyValidator.InvalidSwapRoute.selector);
        account.execute(callData);
    }

    function testRejectsAlteredPathOnFork() public {
        bytes memory callData = _buildCall(
            0.001 ether,
            1,
            address(account),
            uint64(block.timestamp + hook.MAX_SWAP_DEADLINE_SECONDS())
        );
        assembly {
            mstore(add(add(callData, 32), 348), 0x000000000000000000000000000000000000dead)
        }

        vm.expectPartialRevert(TradingAgentPolicyValidator.InvalidSwapRoute.selector);
        account.execute(callData);
    }

    function testRejectsInputAboveCapOnFork() public {
        bytes memory callData = _buildCall(
            hook.MAX_TRADE_VALUE() + 1,
            1,
            address(account),
            uint64(block.timestamp + hook.MAX_SWAP_DEADLINE_SECONDS())
        );

        vm.expectPartialRevert(TradingAgentPolicyValidator.TradeValueTooHigh.selector);
        account.execute(callData);
    }

    function testRejectsDeadlineChangedAfterSigningOnFork() public {
        uint64 deadline = uint64(block.timestamp + hook.MAX_SWAP_DEADLINE_SECONDS());
        bytes memory callData = _buildCall(0.001 ether, 1, address(account), deadline);
        uint64 changedDeadline = deadline - 1;
        assembly {
            mstore(add(add(callData, 32), 252), changedDeadline)
        }

        vm.expectPartialRevert(TradingAgentPolicyValidator.PolicyIntentSignatureInvalid.selector);
        account.execute(callData);
    }

    function _buildCall(
        uint256 amountIn,
        uint256 amountOutMin,
        address recipient,
        uint64 deadline
    ) private returns (bytes memory) {
        TradingAgentPolicyValidator.TradeIntent memory intent =
            _createIntent(amountIn, amountOutMin, recipient, deadline);
        bytes memory routerCall = _encodeRouterCall(amountOutMin, recipient, deadline);
        bytes memory envelope = _signIntent(intent);
        bytes memory execution =
            abi.encodePacked(ROUTER, bytes32(amountIn), routerCall, envelope);
        return abi.encodeWithSelector(EXECUTE_SELECTOR, bytes32(0), execution);
    }

    function _createIntent(
        uint256 amountIn,
        uint256 amountOutMin,
        address recipient,
        uint64 deadline
    ) private returns (TradingAgentPolicyValidator.TradeIntent memory intent) {
        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = USDT;
        intent = TradingAgentPolicyValidator.TradeIntent({
            smartAccount: address(account),
            policyHash: POLICY_HASH,
            router: ROUTER,
            tokenIn: path[0],
            tokenOut: path[1],
            recipient: recipient,
            amountIn: amountIn,
            amountOutMin: amountOutMin,
            deadline: deadline,
            slippageBps: 100,
            maxPriceImpactBps: 300,
            validUntil: uint64(block.timestamp + 20),
            nonce: keccak256(abi.encode(++nonce, address(account), block.timestamp))
        });
    }

    function _encodeRouterCall(uint256 amountOutMin, address recipient, uint64 deadline)
        private
        pure
        returns (bytes memory)
    {
        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = USDT;
        return abi.encodeWithSelector(BUY_SELECTOR, amountOutMin, path, recipient, deadline);
    }

    function _signIntent(TradingAgentPolicyValidator.TradeIntent memory intent)
        private
        returns (bytes memory)
    {
        bytes32 digest = hook.hashTradeIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(INTENT_SIGNER_PRIVATE_KEY, digest);
        return abi.encode(
            POLICY_HASH,
            intent.nonce,
            intent.validUntil,
            uint16(100),
            uint16(300),
            abi.encodePacked(r, s, v)
        );
    }
}
