// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../contracts/TradingAgentPolicyValidatorV2.sol";

interface VmV2 {
    function chainId(uint256 newChainId) external;
    function prank(address sender) external;
    function expectPartialRevert(bytes4 revertData) external;
    function warp(uint256 timestamp) external;
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
    address private constant SIGNER = address(0xB0B);
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
}
