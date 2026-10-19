// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AccountChecks} from "./AccountChecks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MezoFloat} from "../src/MezoFloat.sol";

/// @notice Deploys MezoFloat on Base mainnet (chain 8453) against Circle's native USDC.
///
/// Required env: ADMIN, RELAYER, GUARDIAN
/// Optional env (USDC, 6 decimals, defaults in brackets):
///   ADMIN_DELAY_SECONDS [172800], MAX_PER_TX [25e6], MAX_PER_ADDRESS_PER_DAY [50e6], MAX_GLOBAL_PER_DAY [300e6]
///
/// Dry run (no broadcast):   forge script script/DeployFloat.s.sol --rpc-url $BASE_RPC_URL
/// Broadcast:                add --account <keystore> --broadcast (never pass a raw private key on the CLI)
contract DeployFloat is Script {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external returns (MezoFloat vault) {
        require(block.chainid == 8453, "not Base mainnet");

        address admin = vm.envAddress("ADMIN");
        address relayer = vm.envAddress("RELAYER");
        address guardian = vm.envAddress("GUARDIAN");
        require(admin != address(0) && relayer != address(0) && guardian != address(0), "zero role");
        require(admin != relayer && admin != guardian && relayer != guardian, "roles must differ");

        uint48 delay = uint48(vm.envOr("ADMIN_DELAY_SECONDS", uint256(2 days)));
        uint256 maxPerTx = vm.envOr("MAX_PER_TX", uint256(25e6));
        uint256 maxPerAddr = vm.envOr("MAX_PER_ADDRESS_PER_DAY", uint256(50e6));
        uint256 maxGlobal = vm.envOr("MAX_GLOBAL_PER_DAY", uint256(300e6));

        require(IERC20(BASE_USDC).totalSupply() > 0, "USDC not found");
        AccountChecks.requirePlain(admin, "ADMIN");
        AccountChecks.requirePlain(relayer, "RELAYER");
        AccountChecks.requirePlain(guardian, "GUARDIAN");
        if (admin.code.length == 0) console.log("WARNING: ADMIN is an EOA, use a multisig for mainnet");

        vm.startBroadcast();
        vault = new MezoFloat(IERC20(BASE_USDC), admin, delay, relayer, guardian, maxPerTx, maxPerAddr, maxGlobal);
        vm.stopBroadcast();

        console.log("MezoFloat:", address(vault));
        console.log("admin / relayer / guardian:", admin, relayer, guardian);
        console.log("limits per-tx / per-address / global:", maxPerTx, maxPerAddr, maxGlobal);
    }
}
