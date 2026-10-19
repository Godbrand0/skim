// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MezoFloat
/// @notice USDC float on Base that pays out small withdrawals instantly. Value is settled
///         with the Mezo-side treasury later, in batches, off this contract.
/// @dev Trust model: a relayer key can only call `release`, within per-transaction, per-address
///      and global daily limits, and each `ref` can be used once. The admin (a multisig, with a
///      delayed two-step transfer) manages limits and roles and can withdraw the float. A guardian
///      can pause but not unpause.
contract MezoFloat is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice The token paid out (USDC on Base).
    IERC20 public immutable usdc;

    /// @notice Largest amount a single `release` may pay.
    uint256 public maxPerTx;
    /// @notice Largest total a single recipient may receive per UTC day.
    uint256 public maxPerAddressPerDay;
    /// @notice Largest total the contract may pay out per UTC day.
    uint256 public maxGlobalPerDay;

    /// @notice Whether a `ref` has already been paid.
    mapping(bytes32 ref => bool used) public refUsed;

    mapping(uint256 day => uint256 amount) private _globalSpent;
    mapping(uint256 day => mapping(address recipient => uint256 amount)) private _addressSpent;

    event Released(bytes32 indexed ref, address indexed recipient, uint256 amount);
    event LimitsUpdated(uint256 maxPerTx, uint256 maxPerAddressPerDay, uint256 maxGlobalPerDay);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidRecipient();
    error RefAlreadyUsed(bytes32 ref);
    error ExceedsPerTxLimit(uint256 amount, uint256 limit);
    error ExceedsAddressDailyLimit(uint256 attempted, uint256 limit);
    error ExceedsGlobalDailyLimit(uint256 attempted, uint256 limit);
    error InvalidLimits();

    constructor(
        IERC20 usdc_,
        address admin,
        uint48 adminTransferDelay,
        address relayer,
        address guardian,
        uint256 maxPerTx_,
        uint256 maxPerAddressPerDay_,
        uint256 maxGlobalPerDay_
    ) AccessControlDefaultAdminRules(adminTransferDelay, admin) {
        if (address(usdc_) == address(0) || relayer == address(0) || guardian == address(0)) {
            revert ZeroAddress();
        }
        usdc = usdc_;
        _grantRole(RELAYER_ROLE, relayer);
        _grantRole(GUARDIAN_ROLE, guardian);
        _setLimits(maxPerTx_, maxPerAddressPerDay_, maxGlobalPerDay_);
    }

    // ---------------------------------------------------------------------
    // Payouts
    // ---------------------------------------------------------------------

    /// @notice Pay `amount` USDC to `recipient` for the request identified by `ref`.
    /// @dev `ref` should be a unique id from the payout ledger. Reverts if it was already paid.
    function release(address recipient, uint256 amount, bytes32 ref)
        external
        nonReentrant
        onlyRole(RELAYER_ROLE)
        whenNotPaused
    {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (amount == 0) revert ZeroAmount();
        if (refUsed[ref]) revert RefAlreadyUsed(ref);
        if (amount > maxPerTx) revert ExceedsPerTxLimit(amount, maxPerTx);

        uint256 day = block.timestamp / 1 days;

        uint256 addressTotal = _addressSpent[day][recipient] + amount;
        if (addressTotal > maxPerAddressPerDay) {
            revert ExceedsAddressDailyLimit(addressTotal, maxPerAddressPerDay);
        }
        uint256 globalTotal = _globalSpent[day] + amount;
        if (globalTotal > maxGlobalPerDay) {
            revert ExceedsGlobalDailyLimit(globalTotal, maxGlobalPerDay);
        }

        refUsed[ref] = true;
        _addressSpent[day][recipient] = addressTotal;
        _globalSpent[day] = globalTotal;

        usdc.safeTransfer(recipient, amount);
        emit Released(ref, recipient, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice USDC currently held by the float.
    function floatBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Total paid out so far in the current UTC day.
    function globalSpentToday() external view returns (uint256) {
        return _globalSpent[block.timestamp / 1 days];
    }

    /// @notice Total paid to `recipient` so far in the current UTC day.
    function addressSpentToday(address recipient) external view returns (uint256) {
        return _addressSpent[block.timestamp / 1 days][recipient];
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Update payout limits. All three must be non-zero and ordered
    ///         `maxPerTx <= maxPerAddressPerDay <= maxGlobalPerDay`.
    function setLimits(uint256 maxPerTx_, uint256 maxPerAddressPerDay_, uint256 maxGlobalPerDay_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setLimits(maxPerTx_, maxPerAddressPerDay_, maxGlobalPerDay_);
    }

    /// @notice Withdraw float to `to`. Works while paused so funds can always be recovered.
    function withdraw(address to, uint256 amount) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /// @notice Stop payouts. Callable by the guardian or the admin.
    function pause() external {
        if (!hasRole(GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        }
        _pause();
    }

    /// @notice Resume payouts. Admin only, so a compromised guardian cannot undo a pause.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _setLimits(uint256 maxPerTx_, uint256 maxPerAddressPerDay_, uint256 maxGlobalPerDay_) private {
        if (maxPerTx_ == 0 || maxPerTx_ > maxPerAddressPerDay_ || maxPerAddressPerDay_ > maxGlobalPerDay_) {
            revert InvalidLimits();
        }
        maxPerTx = maxPerTx_;
        maxPerAddressPerDay = maxPerAddressPerDay_;
        maxGlobalPerDay = maxGlobalPerDay_;
        emit LimitsUpdated(maxPerTx_, maxPerAddressPerDay_, maxGlobalPerDay_);
    }
}
