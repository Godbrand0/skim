// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MezoFloat} from "../src/MezoFloat.sol";
import {MezoFloatRefiller} from "../src/MezoFloatRefiller.sol";
import {MezoMockToken} from "./mocks/MezoMocks.sol";

contract MezoFloatRefillerTest is Test {
    MezoMockToken musdc;
    MezoMockToken musd;
    MezoFloat musdcFloat;
    MezoFloat musdFloat;
    MezoFloatRefiller r;

    address admin = makeAddr("admin");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");
    address relayer = makeAddr("relayer");
    address guardian = makeAddr("guardian");
    address stranger = makeAddr("stranger");

    function setUp() public {
        musdc = new MezoMockToken("mUSDC", 6);
        musd = new MezoMockToken("MUSD", 18);
        musdcFloat = new MezoFloat(IERC20(address(musdc)), admin, 2 days, relayer, guardian, 1e6, 1e6, 2e6);
        musdFloat = new MezoFloat(IERC20(address(musd)), admin, 2 days, relayer, guardian, 1e18, 1e18, 2e18);
        r = new MezoFloatRefiller(admin, 2 days, keeper, treasury);

        vm.startPrank(admin);
        r.listFloat(address(musdcFloat), address(musdc), 5e6);
        r.listFloat(address(musdFloat), address(musd), 5e18);
        vm.stopPrank();

        musdc.mint(treasury, 10e6);
        musd.mint(treasury, 10e18);
        vm.startPrank(treasury);
        musdc.approve(address(r), 10e6);
        musd.approve(address(r), 10e18);
        vm.stopPrank();
    }

    function test_refill_moves_treasury_funds_into_the_float() public {
        vm.prank(keeper);
        r.refill(address(musdcFloat), 2e6);
        assertEq(musdcFloat.floatBalance(), 2e6);
        assertEq(musdc.balanceOf(treasury), 8e6);

        vm.prank(keeper);
        r.refill(address(musdFloat), 3e18);
        assertEq(musdFloat.floatBalance(), 3e18);
        assertEq(musd.balanceOf(treasury), 7e18);
    }

    function test_contract_never_holds_funds() public {
        vm.prank(keeper);
        r.refill(address(musdcFloat), 2e6);
        assertEq(musdc.balanceOf(address(r)), 0);
        assertEq(musd.balanceOf(address(r)), 0);
    }

    function test_only_keeper_can_refill() public {
        vm.prank(stranger);
        vm.expectRevert();
        r.refill(address(musdcFloat), 1e6);
        vm.prank(admin);
        vm.expectRevert();
        r.refill(address(musdcFloat), 1e6);
    }

    function test_unlisted_float_is_refused() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MezoFloatRefiller.FloatNotListed.selector, stranger));
        r.refill(stranger, 1e6);
    }

    function test_removed_float_is_refused() public {
        vm.prank(admin);
        r.removeFloat(address(musdcFloat));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MezoFloatRefiller.FloatNotListed.selector, address(musdcFloat)));
        r.refill(address(musdcFloat), 1e6);
    }

    function test_per_call_cap_and_zero() public {
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MezoFloatRefiller.AmountTooLarge.selector, 6e6, 5e6));
        r.refill(address(musdcFloat), 6e6);
        vm.expectRevert(MezoFloatRefiller.ZeroAmount.selector);
        r.refill(address(musdcFloat), 0);
        vm.stopPrank();
    }

    function test_cannot_exceed_the_treasury_allowance() public {
        vm.prank(treasury);
        musdc.approve(address(r), 1e6);
        vm.prank(keeper);
        vm.expectRevert();
        r.refill(address(musdcFloat), 2e6);
    }

    function test_listing_checks_the_floats_token() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MezoFloatRefiller.TokenMismatch.selector, address(musdc), address(musd)));
        r.listFloat(address(musdcFloat), address(musd), 5e18);
    }

    function test_only_admin_lists_and_removes() public {
        vm.startPrank(keeper);
        vm.expectRevert();
        r.listFloat(address(musdcFloat), address(musdc), 1e6);
        vm.expectRevert();
        r.removeFloat(address(musdcFloat));
        vm.expectRevert();
        r.setTreasury(stranger);
        vm.stopPrank();
    }

    function test_treasury_can_change_and_pulls_from_the_new_one() public {
        address t2 = makeAddr("t2");
        musdc.mint(t2, 5e6);
        vm.prank(t2);
        musdc.approve(address(r), 5e6);
        vm.prank(admin);
        r.setTreasury(t2);
        vm.prank(keeper);
        r.refill(address(musdcFloat), 4e6);
        assertEq(musdc.balanceOf(t2), 1e6);
    }

    function test_zero_addresses_are_rejected() public {
        vm.expectRevert(MezoFloatRefiller.ZeroAddress.selector);
        new MezoFloatRefiller(admin, 2 days, address(0), treasury);
        vm.expectRevert(MezoFloatRefiller.ZeroAddress.selector);
        new MezoFloatRefiller(admin, 2 days, keeper, address(0));
        vm.prank(admin);
        vm.expectRevert(MezoFloatRefiller.ZeroAddress.selector);
        r.listFloat(address(0), address(musdc), 1e6);
    }

    function testFuzz_refill_never_exceeds_cap_or_allowance(uint256 amount) public {
        vm.prank(keeper);
        if (amount == 0 || amount > 5e6) {
            vm.expectRevert();
            r.refill(address(musdcFloat), amount);
        } else {
            r.refill(address(musdcFloat), amount);
            assertEq(musdcFloat.floatBalance(), amount);
        }
    }
}
