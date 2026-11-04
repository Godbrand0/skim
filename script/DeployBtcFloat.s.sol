// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MezoBtcFloat} from "../src/MezoBtcFloat.sol";
import {AccountChecks} from "./AccountChecks.sol";

/// @notice Deploys MezoBtcFloat on Mezo mainnet (chain 31612): the native-BTC float that pays users who
///         buy BTC (a gas pack) with USDC on Base. Fund it afterwards by sending BTC to the contract.
///
/// Required env: ADMIN, RELAYER, GUARDIAN
/// Optional env (wei, defaults in brackets; 1e14 wei = 0.0001 BTC):
///   ADMIN_DELAY_SECONDS [172800], MAX_PER_TX_WEI [5e14], MAX_PER_ADDRESS_PER_DAY_WEI [1e15], MAX_GLOBAL_PER_DAY_WEI [5e15]
///
/// The Base side is the existing MezoDeposit (script/DeployDepositBase.s.sol), deployed a second time with USDC only.
/// Dry run:    forge script script/DeployBtcFloat.s.sol --rpc-url $MEZO_RPC_URL
/// Broadcast:  add --account <keystore> --broadcast
contract DeployBtcFloat is Script {
    function run() external returns (MezoBtcFloat vault) {
        require(block.chainid == 31612, "not Mezo mainnet");

        address admin = vm.envAddress("ADMIN");
        address relayer = vm.envAddress("RELAYER");
        address guardian = vm.envAddress("GUARDIAN");
        require(admin != address(0) && relayer != address(0) && guardian != address(0), "zero role");
        require(admin != relayer && admin != guardian && relayer != guardian, "roles must differ");
        AccountChecks.requirePlain(admin, "ADMIN");
        AccountChecks.requirePlain(relayer, "RELAYER");
        AccountChecks.requirePlain(guardian, "GUARDIAN");
        if (admin.code.length == 0) console.log("WARNING: ADMIN is an EOA, use a multisig for mainnet");

        uint48 delay = uint48(vm.envOr("ADMIN_DELAY_SECONDS", uint256(2 days)));
        uint256 maxPerTx = vm.envOr("MAX_PER_TX_WEI", uint256(5e14));
        uint256 maxPerAddr = vm.envOr("MAX_PER_ADDRESS_PER_DAY_WEI", uint256(1e15));
        uint256 maxGlobal = vm.envOr("MAX_GLOBAL_PER_DAY_WEI", uint256(5e15));

        vm.startBroadcast();
        vault = new MezoBtcFloat(admin, delay, relayer, guardian, maxPerTx, maxPerAddr, maxGlobal);
        vm.stopBroadcast();

        console.log("MezoBtcFloat (native BTC, on Mezo):", address(vault));
        console.log("limits per-tx / per-address / global (wei):", maxPerTx, maxPerAddr, maxGlobal);
    }
}
