// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MezoFloat} from "../src/MezoFloat.sol";
import {AccountChecks} from "./AccountChecks.sol";

/// @notice Deploys MezoFloat on Mezo mainnet (chain 31612). This is the float that pays users who deposit USDC on
///         Base. By default it holds mUSDC (the "enter" lane); set PAYOUT_TOKEN to the MUSD address for the lane
///         that pays MUSD. The same contract that pays USDC on Base works unchanged.
///
/// Required env: ADMIN, RELAYER, GUARDIAN
/// Optional env (limits are in the payout token's own units, defaults for mUSDC with 6 decimals in brackets):
///   PAYOUT_TOKEN [mUSDC], ADMIN_DELAY_SECONDS [172800], MAX_PER_TX [25e6], MAX_PER_ADDRESS_PER_DAY [50e6],
///   MAX_GLOBAL_PER_DAY [300e6]. For MUSD (18 decimals) set all three limits explicitly, e.g. 1e18, 1e18, 2e18.
///
/// Dry run:    forge script script/DeployFloatMezo.s.sol --rpc-url $MEZO_RPC_URL
/// Broadcast:  add --account <keystore> --broadcast
contract DeployFloatMezo is Script {
    address internal constant MUSDC = 0x04671C72Aab5AC02A03c1098314b1BB6B560c197;
    address internal constant MUSD = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;

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

        address token = vm.envOr("PAYOUT_TOKEN", MUSDC);
        require(token == MUSDC || token == MUSD, "PAYOUT_TOKEN must be mUSDC or MUSD");
        if (token == MUSD) {
            require(vm.envOr("MAX_PER_TX", uint256(0)) != 0, "set MAX_PER_TX in MUSD units (18 decimals)");
            require(vm.envOr("MAX_PER_ADDRESS_PER_DAY", uint256(0)) != 0, "set MAX_PER_ADDRESS_PER_DAY in MUSD units");
            require(vm.envOr("MAX_GLOBAL_PER_DAY", uint256(0)) != 0, "set MAX_GLOBAL_PER_DAY in MUSD units");
        }
        uint48 delay = uint48(vm.envOr("ADMIN_DELAY_SECONDS", uint256(2 days)));
        uint256 maxPerTx = vm.envOr("MAX_PER_TX", uint256(25e6));
        uint256 maxPerAddr = vm.envOr("MAX_PER_ADDRESS_PER_DAY", uint256(50e6));
        uint256 maxGlobal = vm.envOr("MAX_GLOBAL_PER_DAY", uint256(300e6));

        require(IERC20(token).totalSupply() > 0, "payout token not found");
        // MUSD has 18 decimals: limits left over from a 6-decimal (mUSDC) setup would be a trillionth of what was meant.
        if (token == MUSD) require(maxPerTx >= 1e15 && maxPerAddr >= 1e15 && maxGlobal >= 1e15, "limits look like 6-decimal values; MUSD uses 18");
        if (admin.code.length == 0) console.log("WARNING: ADMIN is an EOA, use a multisig for mainnet");

        vm.startBroadcast();
        vault = new MezoFloat(IERC20(token), admin, delay, relayer, guardian, maxPerTx, maxPerAddr, maxGlobal);
        vm.stopBroadcast();

        console.log(token == MUSD ? "MezoFloat (MUSD, on Mezo):" : "MezoFloat (mUSDC, on Mezo):", address(vault));
        console.log("admin / relayer / guardian:", admin, relayer, guardian);
        console.log("limits per-tx / per-address / global:", maxPerTx, maxPerAddr, maxGlobal);
    }
}
