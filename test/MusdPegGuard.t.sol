// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MusdPegGuard} from "../src/MusdPegGuard.sol";
import {MezoDeposit} from "../src/MezoDeposit.sol";
import {MezoRebalancer} from "../src/MezoRebalancer.sol";
import {MezoMockToken, MockPool, MockPriceFeed} from "./mocks/MezoMocks.sol";

contract PegFixture is Test {
    function _tokens() internal view returns (address[4] memory) {
        return [address(musd), address(musdc), address(musdt), address(btc)];
    }

    function _pools() internal view returns (address[3] memory) {
        return [address(stable), address(usdtPool), address(btcPool)];
    }

    MezoMockToken musd;
    MezoMockToken musdc;
    MezoMockToken btc;
    MezoMockToken musdt;
    MockPool stable; // token0 mUSDC, token1 MUSD (as on mainnet)
    MockPool usdtPool; // token0 MUSD, token1 mUSDT
    MockPool btcPool; // token0 BTC, token1 MUSD
    MockPriceFeed feed;
    MusdPegGuard guard;

    address owner = makeAddr("owner");

    function setUp() public virtual {
        musd = new MezoMockToken("MUSD", 18);
        musdc = new MezoMockToken("mUSDC", 6);
        btc = new MezoMockToken("BTC", 18);
        musdt = new MezoMockToken("mUSDT", 6);
        usdtPool = new MockPool(address(musd), address(musdt));
        usdtPool.setRates(0.995e6, 0);
        stable = new MockPool(address(musdc), address(musd));
        btcPool = new MockPool(address(btc), address(musd));
        feed = new MockPriceFeed(77_000e18);
        // 1 MUSD sells for 0.99 mUSDC
        stable.setRates(0, 0.99e6);
        // 1 BTC = 77,000 MUSD in the pool: reserves 1 BTC / 77,000 MUSD
        btcPool.setReserves(1e18, 77_000e18);
        guard = new MusdPegGuard(owner, _tokens(), _pools(), address(feed), 200, 500);
    }
}

contract MusdPegGuardTest is PegFixture {
    function test_healthy_at_peg() public view {
        (bool ok, uint256 s, uint256 u, uint256 b) = guard.status();
        assertEq(u, 9950);
        assertTrue(ok);
        assertEq(s, 9900);
        assertEq(b, 10_000);
    }

    function test_stable_pool_depeg_trips() public {
        stable.setRates(0, 0.97e6); // 3% below, limit is 2%
        assertFalse(guard.isHealthy());
    }

    function test_exactly_at_limit_is_healthy() public {
        stable.setRates(0, 0.98e6);
        assertTrue(guard.isHealthy());
    }

    function test_btc_pool_cross_check_trips() public {
        // pool says 1 BTC = 83,000 MUSD while the protocol feed says $77,000 -> MUSD worth ~$0.928
        btcPool.setReserves(1e18, 83_000e18);
        (bool ok,,, uint256 b) = guard.status();
        assertFalse(ok);
        assertEq(b, 9277);
    }

    function test_btc_price_up_does_not_trip_when_pool_follows() public {
        feed.set(90_000e18);
        btcPool.setReserves(1e18, 90_000e18);
        assertTrue(guard.isHealthy());
    }

    function test_fails_closed_when_feed_broken() public {
        feed.setBroken(true);
        (bool ok,,, uint256 b) = guard.status();
        assertFalse(ok);
        assertEq(b, 0);
    }

    function test_fails_closed_when_pool_reads_revert() public {
        stable.setRevertReads(true);
        assertFalse(guard.isHealthy());
        stable.setRevertReads(false);
        btcPool.setRevertReads(true);
        assertFalse(guard.isHealthy());
    }

    function test_musdt_pool_depeg_trips() public {
        usdtPool.setRates(0.96e6, 0);
        (bool ok,, uint256 u,) = guard.status();
        assertFalse(ok);
        assertEq(u, 9600);
    }

    function test_fails_closed_when_musdt_pool_reads_revert() public {
        usdtPool.setRevertReads(true);
        assertFalse(guard.isHealthy());
    }

    function test_fails_closed_on_empty_pool() public {
        btcPool.setReserves(0, 0);
        assertFalse(guard.isHealthy());
    }

    function test_rejects_wrong_pool() public {
        address[3] memory bad = [address(btcPool), address(usdtPool), address(btcPool)];
        vm.expectRevert(MusdPegGuard.PoolMismatch.selector);
        new MusdPegGuard(owner, _tokens(), bad, address(feed), 200, 500);
    }

    function test_only_owner_sets_deviations() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        guard.setDeviations(100, 100);
        vm.prank(owner);
        guard.setDeviations(100, 300);
        assertEq(guard.maxStableDeviationBps(), 100);
        stable.setRates(0, 0.985e6);
        assertFalse(guard.isHealthy());
    }

    function test_deviation_bounds() public {
        vm.startPrank(owner);
        vm.expectRevert(MusdPegGuard.InvalidDeviation.selector);
        guard.setDeviations(0, 100);
        vm.expectRevert(MusdPegGuard.InvalidDeviation.selector);
        guard.setDeviations(100, 5001);
        vm.stopPrank();
    }
}

contract DepositPegTest is PegFixture {
    MezoDeposit dep;
    address admin = makeAddr("admin");
    address guardian = makeAddr("guardian");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    function setUp() public override {
        super.setUp();
        dep = new MezoDeposit(admin, 2 days, guardian, treasury);
        vm.startPrank(admin);
        dep.setTokenConfig(address(musd), true, 1e18, 25e18);
        dep.setTokenConfig(address(musdc), true, 1e6, 25e6);
        dep.setPegGuard(address(guard));
        vm.stopPrank();
        musd.mint(alice, 100e18);
        musdc.mint(alice, 100e6);
        vm.startPrank(alice);
        musd.approve(address(dep), type(uint256).max);
        musdc.approve(address(dep), type(uint256).max);
        vm.stopPrank();
    }

    function test_musd_deposit_ok_when_healthy() public {
        vm.prank(alice);
        dep.deposit(address(musd), 5e18, alice);
        assertEq(musd.balanceOf(treasury), 5e18);
    }

    function test_musd_deposit_refused_when_depegged() public {
        stable.setRates(0, 0.9e6);
        vm.prank(alice);
        vm.expectRevert(MezoDeposit.MusdDepegged.selector);
        dep.deposit(address(musd), 5e18, alice);
        assertEq(musd.balanceOf(treasury), 0);
    }

    function test_other_tokens_unaffected_by_musd_depeg() public {
        stable.setRates(0, 0.9e6);
        vm.prank(alice);
        dep.deposit(address(musdc), 5e6, alice);
        assertEq(musdc.balanceOf(treasury), 5e6);
    }

    function test_guard_off_by_default_and_switchable() public {
        MezoDeposit fresh = new MezoDeposit(admin, 2 days, guardian, treasury);
        assertEq(address(fresh.pegGuard()), address(0));
        stable.setRates(0, 0.9e6);
        vm.prank(admin);
        dep.setPegGuard(address(0));
        vm.prank(alice);
        dep.deposit(address(musd), 5e18, alice);
    }

    function test_only_admin_sets_guard() public {
        vm.prank(guardian);
        vm.expectRevert();
        dep.setPegGuard(address(0));
    }
}

contract RebalancerTest is PegFixture {
    MezoRebalancer reb;
    address admin = makeAddr("admin");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");

    function setUp() public override {
        super.setUp();
        reb = new MezoRebalancer(
            admin,
            2 days,
            keeper,
            treasury,
            address(guard),
            _tokens(),
            _pools(),
            [uint256(100e18), 1e18, 100e6, 100e6, 100_000e18],
            [uint256(200), 150, 200, 200, 150]
        );
        musdc.mint(address(stable), 1_000e6);
        musd.mint(address(btcPool), 1_000_000e18);
        musd.mint(address(usdtPool), 1_000e18);
        // BTC pool pays 76,900 MUSD per BTC (-0.13% vs the feed)
        btcPool.setRates(76_900e18, 0);
        // mUSDT -> MUSD at par
        usdtPool.setRates(0.995e6, 1.002e30); // 6 -> 18 decimals: output per 1e18 input units
        musdc.mint(treasury, 300e6);
        btc.mint(address(btcPool), 10e18);
        // buying BTC with MUSD: 77,100 MUSD per BTC (-0.13% vs the feed) => 1e18 MUSD buys 1/77,100 BTC
        btcPool.setRates(76_900e18, uint256(1e36) / 77_100e18);
        // mUSDC -> MUSD at 1.004 (stable pool token0 = mUSDC; rate per 1e18 input units, 6 -> 18 decimals)
        stable.setRates(1.004e30, 0.99e6);
        musd.mint(address(stable), 1_000e18);
        musd.mint(treasury, 100_000e18);
        btc.mint(treasury, 2e18);
        musdt.mint(treasury, 300e6);
        vm.startPrank(treasury);
        musdc.approve(address(reb), type(uint256).max);
        musd.approve(address(reb), type(uint256).max);
        btc.approve(address(reb), type(uint256).max);
        musdt.approve(address(reb), type(uint256).max);
        vm.stopPrank();
    }

    function test_swaps_musd_to_musdc_for_treasury() public {
        vm.prank(keeper);
        uint256 out = reb.rebalance(MezoRebalancer.Route.MusdToMusdc, 50e18, 49e6);
        assertEq(out, 49_500_000);
        assertEq(musd.balanceOf(treasury), 100_000e18 - 50e18);
        assertEq(musdc.balanceOf(treasury), 300e6 + 49_500_000);
        assertEq(musd.balanceOf(address(reb)), 0);
        assertEq(musdc.balanceOf(address(reb)), 0);
    }

    function test_btc_to_musd_uses_price_feed_floor() public {
        vm.prank(keeper);
        uint256 out = reb.rebalance(MezoRebalancer.Route.BtcToMusd, 1e18, 0);
        assertEq(out, 76_900e18);
        assertEq(btc.balanceOf(treasury), 1e18);
        assertEq(musd.balanceOf(treasury), 100_000e18 + 76_900e18);
        assertEq(reb.fairValue(MezoRebalancer.Route.BtcToMusd, 1e18), 77_000e18);
    }

    function test_btc_swap_below_feed_floor_reverts() public {
        btcPool.setRates(75_000e18, 0); // 2.6% under the feed, allowance is 1.5%
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MezoRebalancer.PriceTooLow.selector, 75_000e18, 75_845e18));
        reb.rebalance(MezoRebalancer.Route.BtcToMusd, 1e18, 0);
    }

    function test_musdc_to_musd() public {
        vm.prank(keeper);
        uint256 out = reb.rebalance(MezoRebalancer.Route.MusdcToMusd, 100e6, 0);
        assertEq(out, 100.4e18);
        assertEq(musdc.balanceOf(treasury), 200e6);
    }

    function test_musd_to_btc_floor_from_price_feed() public {
        assertEq(reb.fairValue(MezoRebalancer.Route.MusdToBtc, 77_000e18), 1e18);
        vm.prank(keeper);
        uint256 out = reb.rebalance(MezoRebalancer.Route.MusdToBtc, 77_100e18, 0);
        assertEq(out, (77_100e18 * (uint256(1e36) / 77_100e18)) / 1e18);
        assertGt(out, 0.99e18);
        assertEq(btc.balanceOf(treasury), 2e18 + out);
    }

    function test_musdc_to_btc_in_one_call() public {
        uint256 musdcBefore = musdc.balanceOf(treasury);
        uint256 musdBefore = musd.balanceOf(treasury);
        uint256 btcBefore = btc.balanceOf(treasury);
        vm.prank(keeper);
        uint256 btcOut = reb.rebalanceMusdcToBtc(100e6, 0);
        // 100 mUSDC -> 100.4 MUSD -> 100.4 / 77,100 BTC
        assertEq(btcOut, (100.4e18 * (uint256(1e36) / 77_100e18)) / 1e18);
        assertEq(musdc.balanceOf(treasury), musdcBefore - 100e6);
        assertEq(btc.balanceOf(treasury), btcBefore + btcOut);
        assertEq(musd.balanceOf(treasury), musdBefore, "no MUSD left stranded");
    }

    function test_btc_to_musdc_in_one_call() public {
        uint256 musdBefore = musd.balanceOf(treasury);
        uint256 musdcBefore = musdc.balanceOf(treasury);
        uint256 btcBefore = btc.balanceOf(treasury);
        vm.prank(keeper);
        uint256 out = reb.rebalanceBtcToMusdc(1e15, 0);
        // 0.001 BTC -> 76.9 MUSD -> 76.131 mUSDC
        assertEq(out, 76_131_000);
        assertEq(musdc.balanceOf(treasury), musdcBefore + out);
        assertEq(btc.balanceOf(treasury), btcBefore - 1e15);
        assertEq(musd.balanceOf(treasury), musdBefore, "no MUSD left stranded");
    }

    function test_musdc_to_btc_respects_end_to_end_minimum_and_keeper_role() public {
        vm.prank(keeper);
        vm.expectRevert();
        reb.rebalanceMusdcToBtc(100e6, 1e18); // asks for a whole BTC
        vm.expectRevert();
        reb.rebalanceMusdcToBtc(100e6, 0); // not the keeper
    }

    function test_musd_to_btc_below_floor_reverts() public {
        btcPool.setRates(0, uint256(1e36) / 80_000e18); // pool charges 80,000 MUSD per BTC vs feed 77,000
        vm.prank(keeper);
        vm.expectRevert();
        reb.rebalance(MezoRebalancer.Route.MusdToBtc, 77_000e18, 0);
    }

    function test_musdt_to_musd() public {
        vm.prank(keeper);
        uint256 out = reb.rebalance(MezoRebalancer.Route.MusdtToMusd, 100e6, 0);
        assertEq(out, 100.2e18);
        assertEq(musdt.balanceOf(treasury), 200e6);
    }

    function test_only_keeper() public {
        vm.expectRevert();
        reb.rebalance(MezoRebalancer.Route.MusdToMusdc, 1e18, 0);
    }

    function test_refuses_when_depegged() public {
        stable.setRates(0, 0.95e6);
        vm.prank(keeper);
        vm.expectRevert(MezoRebalancer.MusdDepegged.selector);
        reb.rebalance(MezoRebalancer.Route.MusdToMusdc, 1e18, 0);
    }

    function test_onchain_floor_beats_lax_minout() public {
        vm.prank(admin);
        reb.setRouteLimits(MezoRebalancer.Route.MusdToMusdc, 100e18, 50); // floor 0.995; pool pays 0.99
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MezoRebalancer.PriceTooLow.selector, 9_900_000, 9_950_000));
        reb.rebalance(MezoRebalancer.Route.MusdToMusdc, 10e18, 0);
    }

    function test_keeper_minout_can_tighten() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MezoRebalancer.PriceTooLow.selector, 9_900_000, 9_990_000));
        reb.rebalance(MezoRebalancer.Route.MusdToMusdc, 10e18, 9_990_000);
    }

    function test_per_route_cap_and_zero() public {
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MezoRebalancer.AmountTooLarge.selector, 101e18, 100e18));
        reb.rebalance(MezoRebalancer.Route.MusdToMusdc, 101e18, 0);
        vm.expectRevert(abi.encodeWithSelector(MezoRebalancer.AmountTooLarge.selector, 2e18, 1e18));
        reb.rebalance(MezoRebalancer.Route.BtcToMusd, 2e18, 0);
        vm.expectRevert(MezoRebalancer.ZeroAmount.selector);
        reb.rebalance(MezoRebalancer.Route.MusdToMusdc, 0, 0);
        vm.stopPrank();
    }

    function test_fails_without_treasury_approval() public {
        vm.prank(treasury);
        musd.approve(address(reb), 0);
        vm.prank(keeper);
        vm.expectRevert();
        reb.rebalance(MezoRebalancer.Route.MusdToMusdc, 1e18, 0);
    }

    function test_admin_changes_treasury_and_limits() public {
        address other = makeAddr("other");
        vm.prank(keeper);
        vm.expectRevert();
        reb.setTreasury(other);
        vm.startPrank(admin);
        reb.setTreasury(other);
        assertEq(reb.treasury(), other);
        vm.expectRevert(MezoRebalancer.InvalidLimits.selector);
        reb.setRouteLimits(MezoRebalancer.Route.MusdToMusdc, 1e18, 1001);
        vm.stopPrank();
    }

    function test_rejects_wrong_pool() public {
        address[3] memory bad = [address(btcPool), address(usdtPool), address(btcPool)];
        vm.expectRevert(MezoRebalancer.InvalidPool.selector);
        new MezoRebalancer(
            admin, 2 days, keeper, treasury, address(guard), _tokens(), bad, [uint256(1e18), 1e18, 1e6, 1e6, 1e18], [uint256(200), 150, 200, 200, 150]
        );
    }
}
