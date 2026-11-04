// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AccountChecks} from "./AccountChecks.sol";
import {MezoDeposit} from "../src/MezoDeposit.sol";
import {MusdPegGuard} from "../src/MusdPegGuard.sol";
import {MezoRebalancer} from "../src/MezoRebalancer.sol";

/// @notice Deploys the Mezo side that uses MUSD and Mezo's own contracts: the peg guard (reads the
///         MUSD/mUSDC and BTC/MUSD pools and the MUSD protocol's PriceFeed), a MezoDeposit that
///         consults it, and the rebalancer that sells treasury MUSD for mUSDC through the pool.
///
/// Required env: ADMIN, GUARDIAN, TREASURY, KEEPER
/// Optional env: ADMIN_DELAY_SECONDS [172800]  STABLE_DEVIATION_BPS [200]  BTC_DEVIATION_BPS [500]
///               MAX_SWAP_MUSD [50e18]  MAX_SWAP_BTC_WEI [5e14]  MAX_SWAP_MUSDT [50e6]  MAX_SWAP_MUSDC [50e6]  MAX_SWAP_MUSD_FOR_BTC [50e18]  MAX_SLIPPAGE_BPS [200]  MAX_BTC_SLIPPAGE_BPS [150]
///
/// Dry run:    forge script script/DeployMezoV2.s.sol --rpc-url $MEZO_RPC_URL
/// Broadcast:  add --account <keystore> --broadcast
/// Afterwards the ADMIN runs scripts/wire-mezo-v2.sh (enable tokens, set the guard) and the TREASURY approves the rebalancer.
contract DeployMezoV2 is Script {
    address internal constant MUSD = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;
    address internal constant MUSDC = 0x04671C72Aab5AC02A03c1098314b1BB6B560c197;
    address internal constant STABLE_POOL = 0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356;
    address internal constant MUSDT = 0xeB5a5d39dE4Ea42C2Aa6A57EcA2894376683bB8E;
    address internal constant USDT_POOL = 0x10906a9E9215939561597b4C8e4b98F93c02031A;
    address internal constant BTC_POOL = 0x52e604c44417233b6CcEDDDc0d640A405Caacefb;
    address internal constant BTC = 0x7b7C000000000000000000000000000000000000;
    address internal constant PRICE_FEED = 0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88;

    function run() external returns (MusdPegGuard guard, MezoDeposit dep, MezoRebalancer reb) {
        require(block.chainid == 31612, "not Mezo mainnet");

        address admin = vm.envAddress("ADMIN");
        address guardian = vm.envAddress("GUARDIAN");
        address treasury = vm.envAddress("TREASURY");
        address keeper = vm.envAddress("KEEPER");
        require(admin != address(0) && guardian != address(0) && treasury != address(0) && keeper != address(0), "zero address");
        require(admin != guardian && admin != keeper, "roles must differ");
        AccountChecks.requirePlain(admin, "ADMIN");
        AccountChecks.requirePlain(guardian, "GUARDIAN");
        AccountChecks.requirePlain(treasury, "TREASURY");
        AccountChecks.requirePlain(keeper, "KEEPER");
        if (admin.code.length == 0) console.log("WARNING: ADMIN is an EOA, use a multisig for mainnet");

        uint48 delay = uint48(vm.envOr("ADMIN_DELAY_SECONDS", uint256(2 days)));

        vm.startBroadcast();
        address[4] memory tokens = [MUSD, MUSDC, MUSDT, BTC];
        address[3] memory pools = [STABLE_POOL, USDT_POOL, BTC_POOL];
        guard = new MusdPegGuard(
            admin,
            tokens,
            pools,
            PRICE_FEED,
            vm.envOr("STABLE_DEVIATION_BPS", uint256(200)),
            vm.envOr("BTC_DEVIATION_BPS", uint256(500))
        );
        dep = new MezoDeposit(admin, delay, guardian, treasury);
        uint256 slip = vm.envOr("MAX_SLIPPAGE_BPS", uint256(200));
        reb = new MezoRebalancer(
            admin,
            delay,
            keeper,
            treasury,
            address(guard),
            tokens,
            pools,
            [
                vm.envOr("MAX_SWAP_MUSD", uint256(50e18)),
                vm.envOr("MAX_SWAP_BTC_WEI", uint256(5e14)),
                vm.envOr("MAX_SWAP_MUSDT", uint256(50e6)),
                vm.envOr("MAX_SWAP_MUSDC", uint256(50e6)),
                vm.envOr("MAX_SWAP_MUSD_FOR_BTC", uint256(50e18))
            ],
            [slip, vm.envOr("MAX_BTC_SLIPPAGE_BPS", uint256(150)), slip, slip, vm.envOr("MAX_BTC_SLIPPAGE_BPS", uint256(150))]
        );
        vm.stopBroadcast();

        console.log("MusdPegGuard:   ", address(guard));
        console.log("MezoDeposit:    ", address(dep));
        console.log("MezoRebalancer: ", address(reb));
    }
}
