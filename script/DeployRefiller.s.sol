// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AccountChecks} from "./AccountChecks.sol";
import {MezoFloatRefiller} from "../src/MezoFloatRefiller.sol";

/// @notice Deploys the MezoFloatRefiller on Mezo mainnet and lists the floats it may top up. The broadcaster must be ADMIN,
///         because listing a float is an admin call.
///
/// Required env: ADMIN, KEEPER (the relayer key), TREASURY, ENTER_FLOAT (the mUSDC float), MUSD_FLOAT (the MUSD float)
/// Optional env: ADMIN_DELAY_SECONDS [172800]  MAX_REFILL_MUSDC [5e6]  MAX_REFILL_MUSD [5e18]
///
/// Dry run:    forge script script/DeployRefiller.s.sol --rpc-url $MEZO_RPC_URL --sender $ADMIN
/// Broadcast:  add --account <admin keystore> --broadcast
/// Afterwards the TREASURY approves the refiller for mUSDC and MUSD (see docs/PILOT_MUSD.md).
contract DeployRefiller is Script {
    address internal constant MUSD = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;
    address internal constant MUSDC = 0x04671C72Aab5AC02A03c1098314b1BB6B560c197;

    function run() external returns (MezoFloatRefiller r) {
        require(block.chainid == 31612, "not Mezo mainnet");

        address admin = vm.envAddress("ADMIN");
        address keeper = vm.envAddress("KEEPER");
        address treasury = vm.envAddress("TREASURY");
        address enterFloat = vm.envAddress("ENTER_FLOAT");
        address musdFloat = vm.envAddress("MUSD_FLOAT");
        require(admin != address(0) && keeper != address(0) && treasury != address(0), "zero address");
        require(enterFloat != address(0) && musdFloat != address(0), "zero float");
        require(admin != keeper, "roles must differ");
        AccountChecks.requirePlain(admin, "ADMIN");
        AccountChecks.requirePlain(keeper, "KEEPER");

        uint48 delay = uint48(vm.envOr("ADMIN_DELAY_SECONDS", uint256(2 days)));
        uint256 maxMusdc = vm.envOr("MAX_REFILL_MUSDC", uint256(5e6));
        uint256 maxMusd = vm.envOr("MAX_REFILL_MUSD", uint256(5e18));
        require(maxMusd >= 1e15, "MAX_REFILL_MUSD looks like a 6-decimal value; MUSD uses 18");
        if (admin.code.length == 0) console.log("WARNING: ADMIN is an EOA, use a multisig for mainnet");

        vm.startBroadcast();
        r = new MezoFloatRefiller(admin, delay, keeper, treasury);
        r.listFloat(enterFloat, MUSDC, maxMusdc);
        r.listFloat(musdFloat, MUSD, maxMusd);
        vm.stopBroadcast();

        console.log("MezoFloatRefiller:", address(r));
        console.log("listed mUSDC float / MUSD float:", enterFloat, musdFloat);
        console.log("per-call caps mUSDC / MUSD:", maxMusdc, maxMusd);
    }
}
