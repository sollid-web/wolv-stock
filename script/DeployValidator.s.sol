// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../contracts/TradingAgentPolicyValidator.sol";

interface VmDeploy {
    function addr(uint256 privateKey) external returns (address);
    function envUint(string calldata name) external view returns (uint256);
    function envOr(string calldata name, address defaultValue) external view returns (address value);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

library ScriptConsole {
    address private constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;

    error ConsoleLogFailed();

    function log(string memory label, address value) internal view {
        (bool success,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string,address)", label, value));
        if (!success) revert ConsoleLogFailed();
    }

    function log(string memory label, uint256 value) internal view {
        (bool success,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string,uint256)", label, value));
        if (!success) revert ConsoleLogFailed();
    }
}

contract DeployValidatorScript {
    VmDeploy private constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant BSC_MAINNET_CHAIN_ID = 56;
    uint256 private constant BSC_TESTNET_CHAIN_ID = 97;
    address private constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address private constant MAINNET_PANCAKESWAP_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address private constant TESTNET_PANCAKESWAP_V2_ROUTER = 0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3;

    bytes4 private constant FACTORY_SELECTOR = 0xc45a0155;

    error InvalidChainId(uint256 chainId);
    error ZeroAddress(string variableName);
    error AddressHasNoCode(address account);
    error RouterFactoryCheckFailed(address router);

    function run() external returns (TradingAgentPolicyValidator hook) {
        uint256 configuredChainId = vm.envUint("BSC_CHAIN_ID");
        if (configuredChainId != BSC_MAINNET_CHAIN_ID && configuredChainId != BSC_TESTNET_CHAIN_ID) {
            revert InvalidChainId(configuredChainId);
        }
        if (block.chainid != configuredChainId) {
            revert InvalidChainId(block.chainid);
        }

        address defaultRouter =
            configuredChainId == BSC_MAINNET_CHAIN_ID ? MAINNET_PANCAKESWAP_V2_ROUTER : TESTNET_PANCAKESWAP_V2_ROUTER;
        address router = vm.envOr("PANCAKESWAP_V2_ROUTER", defaultRouter);
        address entryPoint = vm.envOr("ENTRYPOINT_ADDRESS", ENTRY_POINT_V07);
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        if (router == address(0)) revert ZeroAddress("PANCAKESWAP_V2_ROUTER");
        if (entryPoint == address(0)) revert ZeroAddress("ENTRYPOINT_ADDRESS");
        if (deployer == address(0)) revert ZeroAddress("DEPLOYER_PRIVATE_KEY");
        if (router.code.length == 0) revert AddressHasNoCode(router);
        if (entryPoint.code.length == 0) revert AddressHasNoCode(entryPoint);
        if (!_hasFactory(router)) revert RouterFactoryCheckFailed(router);

        vm.startBroadcast(deployerPrivateKey);
        hook = new TradingAgentPolicyValidator(router, entryPoint);
        vm.stopBroadcast();

        ScriptConsole.log("Validator hook", address(hook));
        ScriptConsole.log("Emergency guardian", hook.guardian());
        ScriptConsole.log("Approved router", hook.approvedRouter());
        ScriptConsole.log("EntryPoint", hook.entryPoint());
        ScriptConsole.log("Chain ID", hook.deploymentChainId());
        ScriptConsole.log("ERC-7579 module type", hook.MODULE_TYPE_HOOK());
    }

    function _hasFactory(address router) private view returns (bool) {
        (bool success, bytes memory result) = router.staticcall(abi.encodeWithSelector(FACTORY_SELECTOR));
        if (!success || result.length < 32) return false;

        address factory = abi.decode(result, (address));
        return factory != address(0) && factory.code.length > 0;
    }
}
