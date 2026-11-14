// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../contracts/TradingAgentPolicyValidatorV2.sol";

interface VmV2 {
    function chainId(uint256 newChainId) external;
    function prank(address sender) external;
    function expectPartialRevert(bytes4 revertData) external;
    function warp(uint256 timestamp) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract V2Factory {}
contract V2Router {
    address private immutable factoryAddress;
    constructor(address factory_) { factoryAddress = factory_; }
    function factory() external view returns (address) { return factoryAddress; }
}
contract V2EntryPoint {}
contract V2Token {
    function decimals() external pure returns (uint8) { return 18; }
}
contract V2Feed is IChainlinkAggregatorV3 {
    uint8 public immutable override decimals = 8;
    int256 public answer = 60_000_000;
    uint256 public updatedAt = block.timestamp;
    uint80 public roundId = 1;
    function setRound(int256 answer_, uint256 updatedAt_, uint80 roundId_) external {
        answer = answer_;
        updatedAt = updatedAt_;
        roundId = roundId_;
    }
    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

contract TradingAgentPolicyValidatorV2Test {
    VmV2 private constant vm = VmV2(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ACCOUNT = address(0xA11CE);
    uint256 private constant SIGNER_PRIVATE_KEY = 0xB0B;
    address private SIGNER;
    bytes4 private constant BUY_SELECTOR = 0x7ff36ab5;
    bytes32 private constant POLICY = keccak256("v2-policy");
    V2Factory private factory;
    V2Router private router;
    V2EntryPoint private entryPoint;
    V2Feed private bnbFeed;
    V2Feed private tokenFeed;
    V2Token private token;
    TradingAgentPolicyValidatorV2 private validator;

    function setUp() public {
        vm.chainId(56);
        vm.warp(1_700_000_000);
        SIGNER = vm.addr(SIGNER_PRIVATE_KEY);
        factory = new V2Factory();
        router = new V2Router(address(factory));
        entryPoint = new V2EntryPoint();
        bnbFeed = new V2Feed();
        tokenFeed = new V2Feed();
        token = new V2Token();
        validator = new TradingAgentPolicyValidatorV2(address(router), address(entryPoint), address(bnbFeed));
        vm.prank(ACCOUNT);
        validator.onInstall(abi.encodePacked(bytes1(0), abi.encode(address(token))));
    }

    function testOwnerAccountStoresExactRiskPolicy() public {
        vm.prank(ACCOUNT);
        validator.setAccountPolicy(ACCOUNT, SIGNER, POLICY, 0.1 ether, uint64(block.timestamp + 1 days), 125_000_000, 75, 150);
        (uint64 entry, uint16 slippage, uint16 impact) = validator.getAccountRiskPolicy(ACCOUNT);
        require(entry == 125_000_000 && slippage == 75 && impact == 150, "risk policy mismatch");
    }

    function testRejectsRiskPolicyOutsideHardBounds() public {
        vm.expectPartialRevert(TradingAgentPolicyValidatorV2.PolicyRiskParametersInvalid.selector);
        vm.prank(ACCOUNT);
        validator.setAccountPolicy(ACCOUNT, SIGNER, POLICY, 0.1 ether, uint64(block.timestamp + 1 days), 125_000_000, 501, 150);
    }

    function testOnlyGuardianCanSetTokenFeed() public {
        vm.expectPartialRevert(TradingAgentPolicyValidatorV2.OnlyGuardian.selector);
        vm.prank(ACCOUNT);
        validator.setTokenUsdFeed(address(token), address(tokenFeed), 3600);
    }

    function testGuardianCanAllowlistFreshChainlinkFeed() public {
        validator.setTokenUsdFeed(address(token), address(tokenFeed), 3600);
        require(validator.tokenUsdFeeds(address(token)) == address(tokenFeed), "feed not stored");
    }

    function testRejectsStaleTokenFeedDuringAllowlisting() public {
        tokenFeed.setRound(60_000_000, block.timestamp - 3601, 2);
        vm.expectPartialRevert(TradingAgentPolicyValidatorV2.OraclePriceUnavailable.selector);
        validator.setTokenUsdFeed(address(token), address(tokenFeed), 3600);
    }

    function testRejectsNegativeOrZeroOracleAnswer() public {
        tokenFeed.setRound(0, block.timestamp, 2);
        vm.expectPartialRevert(TradingAgentPolicyValidatorV2.OraclePriceUnavailable.selector);
        validator.setTokenUsdFeed(address(token), address(tokenFeed), 3600);
    }

    function testUninstallClearsDelegatedPolicyAndRiskLimits() public {
        vm.prank(ACCOUNT);
        validator.setAccountPolicy(
            ACCOUNT,
            SIGNER,
            POLICY,
            0.1 ether,
            uint64(block.timestamp + 1 days),
            125_000_000,
            75,
            150
        );

        vm.prank(ACCOUNT);
        validator.onUninstall(bytes(""));

        (bool configured, bytes32 policyHash, uint192 maxTradeValue, uint64 expiresAt, address intentSigner) =
            validator.getAccountPolicy(ACCOUNT);
        (uint64 entryPrice, uint16 slippage, uint16 impact) =
            validator.getAccountRiskPolicy(ACCOUNT);

        require(!configured, "policy remained active after uninstall");
        require(policyHash == bytes32(0), "policy hash not cleared");
        require(maxTradeValue == 0 && expiresAt == 0, "policy limits not cleared");
        require(intentSigner == address(0), "delegated signer not cleared");
        require(entryPrice == 0 && slippage == 0 && impact == 0, "risk limits not cleared");

        vm.prank(ACCOUNT);
        validator.onInstall(abi.encodePacked(bytes1(0), abi.encode(address(token))));
        (configured,,,,) = validator.getAccountPolicy(ACCOUNT);
        require(!configured, "reinstall unexpectedly restored old delegated policy");
    }

    function testRejectsFutureOracleRound() public {
        tokenFeed.setRound(60_000_000, block.timestamp + 1, 2);
        vm.expectPartialRevert(TradingAgentPolicyValidatorV2.OraclePriceUnavailable.selector);
        validator.setTokenUsdFeed(address(token), address(tokenFeed), 3600);
    }

    function testRejectsTooShortFeedFreshnessWindow() public {
        vm.expectPartialRevert(TradingAgentPolicyValidatorV2.InvalidOracleFeed.selector);
        validator.setTokenUsdFeed(address(token), address(tokenFeed), 59);
    }

    function testValidSignedTradePassesOnChainOracleAndPolicyChecks() public {
        bytes memory callData = _buildSignedTrade(
            59_400_000_000_000_000_000,
            2_000_000,
            100,
            150,
            100_000_000
        );
        vm.prank(ACCOUNT);
        bytes memory hookData = validator.preCheck(address(entryPoint), 0, callData);
        require(hookData.length == 96, "hook receipt data missing");
        require(validator.getRollingVolume(ACCOUNT) == 0.1 ether, "rolling volume not recorded");
        vm.prank(ACCOUNT);
        validator.postCheck(hookData);
    }

    function testRejectsOraclePriceAboveOwnerEntryCeiling() public {
        bytes memory callData = _buildSignedTrade(
            59_400_000_000_000_000_000,
            2_000_000,
            100,
            150,
            200_000_001
        );
        vm.expectPartialRevert(TradingAgentPolicyValidatorV2.OraclePriceAboveEntryLimit.selector);
        vm.prank(ACCOUNT);
        validator.preCheck(address(entryPoint), 0, callData);
    }

    function testRejectsMinimumOutputBelowChainlinkOracleFloor() public {
        bytes memory callData = _buildSignedTrade(
            59 ether,
            2_000_000,
            100,
            150,
            100_000_000
        );
        vm.expectPartialRevert(TradingAgentPolicyValidatorV2.OraclePriceImpactExceeded.selector);
        vm.prank(ACCOUNT);
        validator.preCheck(address(entryPoint), 0, callData);
    }

    function testHonorsStricterSignedSlippageBound() public {
        bytes memory callData = _buildSignedTrade(
            59_600_000_000_000_000_000,
            2_000_000,
            50,
            150,
            100_000_000
        );
        vm.expectPartialRevert(TradingAgentPolicyValidatorV2.OraclePriceImpactExceeded.selector);
        vm.prank(ACCOUNT);
        validator.preCheck(address(entryPoint), 0, callData);
    }

    function _buildSignedTrade(
        uint256 amountOutMin,
        uint64 entryPriceMicros,
        uint16 slippageBps,
        uint16 maxPriceImpactBps,
        int256 tokenUsdAnswer
    ) private returns (bytes memory) {
        bnbFeed.setRound(60_000_000_000, block.timestamp, 1);
        tokenFeed.setRound(tokenUsdAnswer, block.timestamp, 1);
        validator.setTokenUsdFeed(address(token), address(tokenFeed), 3600);
        vm.prank(ACCOUNT);
        validator.setAccountPolicy(
            ACCOUNT,
            SIGNER,
            POLICY,
            0.5 ether,
            uint64(block.timestamp + 1 days),
            entryPriceMicros,
            100,
            150
        );

        uint64 deadline = uint64(block.timestamp + 10);
        uint64 validUntil = uint64(block.timestamp + 12);
        bytes32 nonce = keccak256(abi.encode(amountOutMin, tokenUsdAnswer, slippageBps, maxPriceImpactBps));
        address[] memory path = new address[](2);
        path[0] = validator.wrappedNativeToken();
        path[1] = address(token);
        TradingAgentPolicyValidatorV2.TradeIntent memory intent =
            TradingAgentPolicyValidatorV2.TradeIntent({
                smartAccount: ACCOUNT,
                policyHash: POLICY,
                router: address(router),
                tokenIn: path[0],
                tokenOut: address(token),
                recipient: ACCOUNT,
                amountIn: 0.1 ether,
                amountOutMin: amountOutMin,
                deadline: deadline,
                slippageBps: slippageBps,
                maxPriceImpactBps: maxPriceImpactBps,
                validUntil: validUntil,
                nonce: nonce
            });
        bytes32 digest = validator.hashTradeIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PRIVATE_KEY, digest);
        bytes memory signature = abi.encodePacked(r, s, v);
        bytes memory routerCall = bytes.concat(
            abi.encodeWithSelector(
                BUY_SELECTOR,
                amountOutMin,
                path,
                ACCOUNT,
                uint256(deadline)
            ),
            abi.encode(POLICY, nonce, validUntil, slippageBps, maxPriceImpactBps, signature)
        );
        bytes memory execution = abi.encodePacked(address(router), uint256(0.1 ether), routerCall);
        return abi.encodeWithSelector(
            bytes4(keccak256("execute(bytes32,bytes)")),
            bytes32(0),
            execution
        );
    }

}
