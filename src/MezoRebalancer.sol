// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IRebalancePool {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IPegGuard {
    function isHealthy() external view returns (bool);
    function priceFeed() external view returns (address);
}

interface IFeed {
    function fetchPrice() external view returns (uint256);
}

/// @title MezoRebalancer
/// @notice Turns what deposits leave in the treasury into mUSDC through Mezo's own pools, so the
///         treasury can reach the Native Bridge's 20 mUSDC minimum:
///           MusdToMusdc  MUSD  -> mUSDC   (MUSD/mUSDC stable pool)
///           BtcToMusd    BTC   -> MUSD    (BTC/MUSD pool; floor from the MUSD protocol's PriceFeed)
///           MusdtToMusd  mUSDT -> MUSD    (MUSD/mUSDT stable pool)
///           MusdcToMusd  mUSDC -> MUSD    (MUSD/mUSDC stable pool, the other way)
///           MusdToBtc    MUSD  -> BTC     (BTC/MUSD pool, the other way; floor from the PriceFeed)
///         Chain them with two calls: BTC -> MUSD -> mUSDC to cash out, mUSDC -> MUSD -> BTC to buy gas BTC. It never holds funds: it pulls from the
///         treasury (which must approve it) straight into the pool, and the pool pays the treasury.
/// @dev A compromised keeper can only trigger these three swaps, to this one treasury, up to each
///      route's cap, while MUSD is healthy per `MusdPegGuard`, at a price no worse than the route's
///      on-chain floor (par for the stable routes, PriceFeed for BTC) whatever `minOut` it passes.
contract MezoRebalancer is AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Route {
        MusdToMusdc,
        BtcToMusd,
        MusdtToMusd,
        MusdcToMusd,
        MusdToBtc
    }

    struct RouteConfig {
        IRebalancePool pool;
        IERC20 tokenIn;
        IERC20 tokenOut;
        uint8 decimalsIn;
        uint8 decimalsOut;
        uint256 maxIn; // largest amount of tokenIn per call, in tokenIn units
        uint256 maxSlippageBps; // how far under the floor price a swap may pay
    }

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    uint256 internal constant BPS = 10_000;

    IPegGuard public immutable guard;
    address public immutable btcToken;
    address public treasury;
    mapping(Route => RouteConfig) public routes;

    event Rebalanced(address indexed keeper, Route indexed route, uint256 amountIn, uint256 amountOut);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event RouteLimitsUpdated(Route indexed route, uint256 maxIn, uint256 maxSlippageBps);

    error ZeroAddress();
    error InvalidLimits();
    error InvalidPool();
    error MusdDepegged();
    error AmountTooLarge(uint256 amount, uint256 max);
    error ZeroAmount();
    error PriceTooLow(uint256 out, uint256 required);

    /// @param tokens [MUSD, mUSDC, mUSDT, BTC]   @param pools [MUSD/mUSDC, MUSD/mUSDT, BTC/MUSD]
    /// @param maxIn per-route caps in the input token's units, in `Route` order
    /// @param slippageBps per-route slippage allowances, in `Route` order
    constructor(
        address admin,
        uint48 adminTransferDelay,
        address keeper,
        address treasury_,
        address guard_,
        address[4] memory tokens,
        address[3] memory pools,
        uint256[5] memory maxIn,
        uint256[5] memory slippageBps
    ) AccessControlDefaultAdminRules(adminTransferDelay, admin) {
        if (keeper == address(0) || guard_ == address(0)) revert ZeroAddress();
        for (uint256 i; i < 4; i++) if (tokens[i] == address(0)) revert ZeroAddress();
        guard = IPegGuard(guard_);
        btcToken = tokens[3];
        _grantRole(KEEPER_ROLE, keeper);
        _setTreasury(treasury_);
        // tokens: 0 MUSD, 1 mUSDC, 2 mUSDT, 3 BTC
        _addRoute(Route.MusdToMusdc, pools[0], tokens[0], tokens[1], maxIn[0], slippageBps[0]);
        _addRoute(Route.BtcToMusd, pools[2], tokens[3], tokens[0], maxIn[1], slippageBps[1]); // BTC is 18 decimals, priced by PriceFeed
        _addRoute(Route.MusdtToMusd, pools[1], tokens[2], tokens[0], maxIn[2], slippageBps[2]);
        _addRoute(Route.MusdcToMusd, pools[0], tokens[1], tokens[0], maxIn[3], slippageBps[3]);
        _addRoute(Route.MusdToBtc, pools[2], tokens[0], tokens[3], maxIn[4], slippageBps[4]);
    }

    /// @notice Swap `amountIn` of the route's input token held by the treasury into its output token,
    ///         paid to the treasury.
    /// @param minOut Caller's own minimum output; the on-chain floor applies as well.
    function rebalance(Route route, uint256 amountIn, uint256 minOut)
        external
        onlyRole(KEEPER_ROLE)
        nonReentrant
        returns (uint256 received)
    {
        received = _swap(route, amountIn, minOut);
    }

    /// @notice mUSDC to BTC in one transaction: mUSDC -> MUSD (stable pool), then all of that MUSD -> BTC
    ///         (BTC pool). Each leg keeps its own on-chain floor; `minBtcOut` is the caller's end-to-end minimum.
    /// @return btcReceived BTC paid to the treasury.
    function rebalanceMusdcToBtc(uint256 musdcIn, uint256 minBtcOut)
        external
        onlyRole(KEEPER_ROLE)
        nonReentrant
        returns (uint256 btcReceived)
    {
        uint256 musdOut = _swap(Route.MusdcToMusd, musdcIn, 0);
        btcReceived = _swap(Route.MusdToBtc, musdOut, minBtcOut);
    }

    /// @notice BTC to mUSDC in one transaction: BTC -> MUSD (BTC pool, floor from the PriceFeed), then all
    ///         of that MUSD -> mUSDC (stable pool). The cash-out direction, mirror of `rebalanceMusdcToBtc`.
    /// @return musdcReceived mUSDC paid to the treasury.
    function rebalanceBtcToMusdc(uint256 btcIn, uint256 minMusdcOut)
        external
        onlyRole(KEEPER_ROLE)
        nonReentrant
        returns (uint256 musdcReceived)
    {
        uint256 musdOut = _swap(Route.BtcToMusd, btcIn, 0);
        musdcReceived = _swap(Route.MusdToMusdc, musdOut, minMusdcOut);
    }

    function _swap(Route route, uint256 amountIn, uint256 minOut) private returns (uint256 received) {
        RouteConfig memory r = routes[route];
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > r.maxIn) revert AmountTooLarge(amountIn, r.maxIn);
        if (!guard.isHealthy()) revert MusdDepegged();

        uint256 out = r.pool.getAmountOut(amountIn, address(r.tokenIn));
        uint256 floor = (_fairValue(route, r, amountIn) * (BPS - r.maxSlippageBps)) / BPS;
        uint256 required = minOut > floor ? minOut : floor;
        if (out < required) revert PriceTooLow(out, required);

        address to = treasury;
        uint256 balanceBefore = r.tokenOut.balanceOf(to);
        r.tokenIn.safeTransferFrom(to, address(r.pool), amountIn);
        (uint256 out0, uint256 out1) = r.pool.token0() == address(r.tokenOut) ? (out, uint256(0)) : (uint256(0), out);
        r.pool.swap(out0, out1, to, "");
        received = r.tokenOut.balanceOf(to) - balanceBefore;
        if (received < required) revert PriceTooLow(received, required);

        emit Rebalanced(msg.sender, route, amountIn, received);
    }

    /// @notice The output the route should pay at fair value, in output-token units, before slippage.
    function fairValue(Route route, uint256 amountIn) external view returns (uint256) {
        return _fairValue(route, routes[route], amountIn);
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTreasury(newTreasury);
    }

    function setRouteLimits(Route route, uint256 maxIn, uint256 maxSlippageBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (maxIn == 0 || maxSlippageBps == 0 || maxSlippageBps > 1000) revert InvalidLimits();
        routes[route].maxIn = maxIn;
        routes[route].maxSlippageBps = maxSlippageBps;
        emit RouteLimitsUpdated(route, maxIn, maxSlippageBps);
    }

    /// @dev Stable routes are priced at par ($1 per token). BTC is priced by the MUSD protocol's own
    ///      PriceFeed (USD per BTC, 18 decimals) with MUSD at $1.
    function _fairValue(Route route, RouteConfig memory r, uint256 amountIn) private view returns (uint256) {
        if (route == Route.BtcToMusd) return (amountIn * IFeed(guard.priceFeed()).fetchPrice()) / 1e18;
        if (route == Route.MusdToBtc) return (amountIn * 1e18) / IFeed(guard.priceFeed()).fetchPrice();
        return r.decimalsOut >= r.decimalsIn
            ? amountIn * 10 ** (r.decimalsOut - r.decimalsIn)
            : amountIn / 10 ** (r.decimalsIn - r.decimalsOut);
    }

    function _addRoute(Route route, address pool, address tokenIn, address tokenOut, uint256 maxIn, uint256 slippageBps)
        private
    {
        if (maxIn == 0 || slippageBps == 0 || slippageBps > 1000) revert InvalidLimits();
        if (pool == address(0)) revert ZeroAddress();
        // the pool must hold exactly this pair
        address t0 = IRebalancePool(pool).token0();
        address t1 = IRebalancePool(pool).token1();
        if (!((t0 == tokenIn && t1 == tokenOut) || (t0 == tokenOut && t1 == tokenIn))) revert InvalidPool();
        routes[route] = RouteConfig(
            IRebalancePool(pool),
            IERC20(tokenIn),
            IERC20(tokenOut),
            _dec(tokenIn),
            _dec(tokenOut),
            maxIn,
            slippageBps
        );
    }

    /// @dev The BTC token is 18 decimals; its decimals() is backed by a precompile, so it is not queried.
    function _dec(address token) private view returns (uint8) {
        if (token == btcToken) return 18;
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || data.length < 32) revert InvalidPool();
        return abi.decode(data, (uint8));
    }

    function _setTreasury(address newTreasury) private {
        if (newTreasury == address(0) || newTreasury == address(this)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }
}
