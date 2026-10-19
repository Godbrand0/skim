// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AccountChecks} from "./AccountChecks.sol";
import {MezoDeposit} from "../src/MezoDeposit.sol";

/// @notice Deploys MezoDeposit on Mezo mainnet (chain 31612) and enables MUSD, mUSDC and native BTC.
///
/// Required env: ADMIN, GUARDIAN, TREASURY
/// Optional env: ADMIN_DELAY_SECONDS [172800]
///   Per-deposit limits, in each token's own units:
///   MUSD_MIN [1e18] MUSD_MAX [25e18]  MUSDC_MIN [1e6] MUSDC_MAX [25e6]  BTC_MIN_WEI [1e13] BTC_MAX_WEI [3e14]
///
/// Dry run:    forge script script/DeployDeposit.s.sol --rpc-url $MEZO_RPC_URL
/// Broadcast:  add --account <keystore> --broadcast
contract DeployDeposit is Script {
    address internal constant MUSD = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;
    address internal constant MUSDC = 0x04671C72Aab5AC02A03c1098314b1BB6B560c197;

    function run() external returns (MezoDeposit dep) {
        require(block.chainid == 31612, "not Mezo mainnet");

        address admin = vm.envAddress("ADMIN");
        address guardian = vm.envAddress("GUARDIAN");
        address treasury = vm.envAddress("TREASURY");
        require(admin != address(0) && guardian != address(0) && treasury != address(0), "zero address");
        require(admin != guardian, "roles must differ");

        uint48 delay = uint48(vm.envOr("ADMIN_DELAY_SECONDS", uint256(2 days)));
        AccountChecks.requirePlain(admin, "ADMIN");
        AccountChecks.requirePlain(guardian, "GUARDIAN");
        AccountChecks.requirePlain(treasury, "TREASURY");
        if (admin.code.length == 0) console.log("WARNING: ADMIN is an EOA, use a multisig for mainnet");

        vm.startBroadcast();
        dep = new MezoDeposit(admin, delay, guardian, treasury);
        vm.stopBroadcast();

        console.log("MezoDeposit:", address(dep));
        console.log(
            "The ADMIN must now call setTokenConfig for MUSD, mUSDC and NATIVE (see scripts/configure-deposit.sh)."
        );
    }
}
