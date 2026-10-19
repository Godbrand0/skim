// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {MezoDeposit} from "../src/MezoDeposit.sol";

contract MockToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, uint8 d) ERC20(n, n) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Burns 1% on transfer, to prove the contract rejects fee-on-transfer tokens.
contract FeeToken is MockToken {
    constructor() MockToken("FEE", 6) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Treasury that tries to re-enter `depositNative` when it receives BTC.
contract ReentrantTreasury {
    MezoDeposit public target;
    bool public reentered;

    function setTarget(MezoDeposit t) external {
        target = t;
    }

    receive() external payable {
        try target.depositNative{value: 1}(address(0xBEEF)) {
            reentered = true;
        } catch {}
    }
}

contract RejectingTreasury {
    receive() external payable {
        revert("no");
    }
}

contract MezoDepositTest is Test {
    MockToken musd;
    MockToken musdc;
    MezoDeposit dep;

    address admin = makeAddr("admin");
    address guardian = makeAddr("guardian");
    address treasury = makeAddr("treasury");
    address user = makeAddr("user");
    address baseRecipient = makeAddr("baseRecipient");

    function setUp() public {
        musd = new MockToken("MUSD", 18);
        musdc = new MockToken("mUSDC", 6);
        dep = new MezoDeposit(admin, 2 days, guardian, treasury);

        vm.startPrank(admin);
        dep.setTokenConfig(address(musd), true, 1e18, 25e18);
        dep.setTokenConfig(address(musdc), true, 1e6, 25e6);
        dep.setTokenConfig(dep.NATIVE(), true, 1e13, 3e14); // 0.00001 to 0.0003 BTC
        vm.stopPrank();

        musd.mint(user, 100e18);
        musdc.mint(user, 100e6);
        vm.deal(user, 1 ether);
        vm.startPrank(user);
        musd.approve(address(dep), type(uint256).max);
        musdc.approve(address(dep), type(uint256).max);
        vm.stopPrank();
    }

    function test_deposit_forwards_to_treasury_and_emits() public {
        bytes32 expectedId = keccak256(abi.encode(block.chainid, address(dep), uint256(0)));

        vm.expectEmit(true, true, true, true);
        emit MezoDeposit.Deposit(0, expectedId, user, address(musdc), 5e6, baseRecipient);
        vm.prank(user);
        bytes32 id = dep.deposit(address(musdc), 5e6, baseRecipient);

        assertEq(id, expectedId);
        assertEq(musdc.balanceOf(treasury), 5e6);
        assertEq(musdc.balanceOf(address(dep)), 0);
        assertEq(dep.nextNonce(), 1);
    }

    function test_deposit_18_decimal_token() public {
        vm.prank(user);
        dep.deposit(address(musd), 3e18, baseRecipient);
        assertEq(musd.balanceOf(treasury), 3e18);
    }

    function test_native_deposit_forwards_and_holds_nothing() public {
        vm.prank(user);
        bytes32 id = dep.depositNative{value: 1e14}(baseRecipient);

        assertEq(treasury.balance, 1e14);
        assertEq(address(dep).balance, 0);
        assertEq(id, keccak256(abi.encode(block.chainid, address(dep), uint256(0))));
    }

    function test_ids_are_unique_and_sequential() public {
        vm.startPrank(user);
        bytes32 a = dep.deposit(address(musdc), 2e6, baseRecipient);
        bytes32 b = dep.deposit(address(musdc), 2e6, baseRecipient);
        bytes32 c = dep.depositNative{value: 1e14}(baseRecipient);
        vm.stopPrank();
        assertTrue(a != b && b != c && a != c);
        assertEq(dep.nextNonce(), 3);
    }

    function test_rejects_disabled_token() public {
        MockToken other = new MockToken("X", 6);
        other.mint(user, 10e6);
        vm.startPrank(user);
        other.approve(address(dep), 10e6);
        vm.expectRevert(abi.encodeWithSelector(MezoDeposit.TokenNotEnabled.selector, address(other)));
        dep.deposit(address(other), 2e6, baseRecipient);
        vm.stopPrank();
    }

    function test_rejects_amount_out_of_range() public {
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(MezoDeposit.AmountOutOfRange.selector, 0.5e6, 1e6, 25e6));
        dep.deposit(address(musdc), 0.5e6, baseRecipient);
        vm.expectRevert(abi.encodeWithSelector(MezoDeposit.AmountOutOfRange.selector, 26e6, 1e6, 25e6));
        dep.deposit(address(musdc), 26e6, baseRecipient);
        vm.expectRevert(abi.encodeWithSelector(MezoDeposit.AmountOutOfRange.selector, 1e12, 1e13, 3e14));
        dep.depositNative{value: 1e12}(baseRecipient);
        vm.stopPrank();
    }

    function test_rejects_zero_recipient() public {
        vm.startPrank(user);
        vm.expectRevert(MezoDeposit.InvalidRecipient.selector);
        dep.deposit(address(musdc), 2e6, address(0));
        vm.expectRevert(MezoDeposit.InvalidRecipient.selector);
        dep.depositNative{value: 1e14}(address(0));
        vm.stopPrank();
    }

    function test_native_key_cannot_use_erc20_path() public {
        vm.prank(user);
        vm.expectRevert(MezoDeposit.NativeKeyNotAllowed.selector);
        dep.deposit(address(0), 1e14, baseRecipient);
    }

    function test_rejects_fee_on_transfer_token() public {
        FeeToken fee = new FeeToken();
        fee.mint(user, 100e6);
        vm.prank(admin);
        dep.setTokenConfig(address(fee), true, 1e6, 25e6);

        vm.startPrank(user);
        fee.approve(address(dep), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(MezoDeposit.TransferShortfall.selector, 10e6, 9.9e6));
        dep.deposit(address(fee), 10e6, baseRecipient);
        vm.stopPrank();
    }

    function test_native_reentrancy_is_blocked() public {
        ReentrantTreasury rt = new ReentrantTreasury();
        MezoDeposit d = new MezoDeposit(admin, 2 days, guardian, address(rt));
        rt.setTarget(d);
        address native = d.NATIVE();
        vm.prank(admin);
        d.setTokenConfig(native, true, 1, 3e14);

        vm.prank(user);
        d.depositNative{value: 1e14}(baseRecipient);
        assertFalse(rt.reentered());
        assertEq(d.nextNonce(), 1);
    }

    function test_native_reverts_if_treasury_rejects() public {
        RejectingTreasury rj = new RejectingTreasury();
        MezoDeposit d = new MezoDeposit(admin, 2 days, guardian, address(rj));
        address native = d.NATIVE();
        vm.prank(admin);
        d.setTokenConfig(native, true, 1, 3e14);

        vm.prank(user);
        vm.expectRevert(MezoDeposit.NativeTransferFailed.selector);
        d.depositNative{value: 1e14}(baseRecipient);
    }

    function test_pause_blocks_deposits_guardian_pause_admin_unpause() public {
        vm.prank(guardian);
        dep.pause();

        vm.startPrank(user);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        dep.deposit(address(musdc), 2e6, baseRecipient);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        dep.depositNative{value: 1e14}(baseRecipient);
        vm.stopPrank();

        vm.prank(guardian);
        vm.expectRevert();
        dep.unpause();

        vm.prank(admin);
        dep.unpause();
        vm.prank(user);
        dep.deposit(address(musdc), 2e6, baseRecipient);
    }

    function test_admin_only_config() public {
        vm.startPrank(user);
        vm.expectRevert();
        dep.setTokenConfig(address(musdc), true, 1, 2);
        vm.expectRevert();
        dep.setTreasury(user);
        vm.stopPrank();

        vm.startPrank(admin);
        vm.expectRevert(MezoDeposit.InvalidTokenConfig.selector);
        dep.setTokenConfig(address(musdc), true, 0, 2);
        vm.expectRevert(MezoDeposit.InvalidTokenConfig.selector);
        dep.setTokenConfig(address(musdc), true, 5, 2);
        vm.stopPrank();
    }

    function test_set_treasury_validates_and_redirects() public {
        address newTreasury = makeAddr("newTreasury");
        vm.startPrank(admin);
        vm.expectRevert(MezoDeposit.ZeroAddress.selector);
        dep.setTreasury(address(0));
        vm.expectRevert(MezoDeposit.InvalidTreasury.selector);
        dep.setTreasury(address(dep));
        dep.setTreasury(newTreasury);
        vm.stopPrank();

        vm.prank(user);
        dep.deposit(address(musdc), 2e6, baseRecipient);
        assertEq(musdc.balanceOf(newTreasury), 2e6);
        assertEq(musdc.balanceOf(treasury), 0);
    }

    function test_disabling_token_stops_deposits() public {
        vm.prank(admin);
        dep.setTokenConfig(address(musdc), false, 1e6, 25e6);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MezoDeposit.TokenNotEnabled.selector, address(musdc)));
        dep.deposit(address(musdc), 2e6, baseRecipient);
    }

    function testFuzz_deposit_in_range_always_forwards(uint256 amount) public {
        amount = bound(amount, 1e6, 25e6);
        vm.prank(user);
        dep.deposit(address(musdc), amount, baseRecipient);
        assertEq(musdc.balanceOf(treasury), amount);
        assertEq(musdc.balanceOf(address(dep)), 0);
    }
}
