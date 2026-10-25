// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MezoFloat} from "../src/MezoFloat.sol";
import {AccountChecks} from "./AccountChecks.sol";

/// @notice Deploys MezoFloat on Mezo mainnet (chain 31612) holding mUSDC. This is the float that pays users who
///         deposit USDC on Base (the "enter" lane). The same contract that pays USDC on Base works unchanged.
///
/// Required env: ADMIN, RELAYER, GUARDIAN
/// Optional env (mUSDC, 6 decimals, defaults in brackets):
///   ADMIN_DELAY_SECONDS [172800], MAX_PER_TX [25e6], MAX_PER_ADDRESS_PER_DAY [50e6], MAX_GLOBAL_PER_DAY [300e6]
///
/// Dry run:    forge script script/DeployFloatMezo.s.sol --rpc-url $MEZO_RPC_URL
/// Broadcast:  add --account <keystore> --broadcast
contract DeployFloatMezo is Script {
    address internal constant MUSDC = 0x04671C72Aab5AC02A03c1098314b1BB6B560c197;

    function run() external returns (MezoFloat vault) {
        require(block.chainid == 31612, "not Mezo mainnet");

        address admin = vm.envAddress("ADMIN");
        address relayer = vm.envAddress("RELAYER");
        address guardian = vm.envAddress("GUARDIAN");
        require(admin != address(0) && relayer != address(0) && guardian != address(0), "zero role");
        require(admin != relayer && admin != guardian && relayer != guardian, "roles must differ");
        AccountChecks.requirePlain(admin, "ADMIN");
        AccountChecks.requirePlain(relayer, "RELAYER");
        AccountChecks.requirePlain(guardian, "GUARDIAN");

        uint48 delay = uint48(vm.envOr("ADMIN_DELAY_SECONDS", uint256(2 days)));
        uint256 maxPerTx = vm.envOr("MAX_PER_TX", uint256(25e6));
        uint256 maxPerAddr = vm.envOr("MAX_PER_ADDRESS_PER_DAY", uint256(50e6));
        uint256 maxGlobal = vm.envOr("MAX_GLOBAL_PER_DAY", uint256(300e6));

        require(IERC20(MUSDC).totalSupply() > 0, "mUSDC not found");
        if (admin.code.length == 0) console.log("WARNING: ADMIN is an EOA, use a multisig for mainnet");

        vm.startBroadcast();
        vault = new MezoFloat(IERC20(MUSDC), admin, delay, relayer, guardian, maxPerTx, maxPerAddr, maxGlobal);
        vm.stopBroadcast();

        console.log("MezoFloat (mUSDC, on Mezo):", address(vault));
        console.log("admin / relayer / guardian:", admin, relayer, guardian);
        console.log("limits per-tx / per-address / global:", maxPerTx, maxPerAddr, maxGlobal);
    }
}
