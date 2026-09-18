// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {XorrDelegation} from "../src/XorrDelegation.sol";

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

/// Uniswap v3 QuoterV2 on X Layer. `quoteExactInput` is non-view by design (it reverts internally) but callable.
interface IQuoterV2 {
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256 gasEstimate);
}

/// SwapRouter02's `exactInput` — no deadline in this router's struct.
interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * The whole permission, on a fork of X Layer mainnet, against the real tokens and pools (PLAN.md P3.2).
 *
 * Grants $100/day for 7 days with only Uniswap's SwapRouter02 on the allowlist, then:
 *   - buys wrapped TSLAx directly against USDC and wrapped NVDAx through USDG, through `spend`, into the owner's wallet;
 *   - refuses a buy past the day's cap, and a call to a venue the owner did not allow;
 *   - sells TSLAx back through `closePosition`;
 *   - stops everything once the owner revokes.
 *
 * Runs only with `XLAYER_RPC` set (e.g. https://rpc.xlayer.tech): `forge test --match-path "*XLayer.fork*"`.
 */
contract XorrXLayerForkTest is Test {
    address internal constant USDC = 0xB6CEceAB302E2E4948951eE7843FC24E92933061;
    address internal constant USDG = 0x4ae46a509F6b1D9056937BA4500cb143933D2dc8;
    address internal constant W_TSLAX = 0xc3FdBe3A68EE5dE461D30415a8165cf9Aefe1171;
    address internal constant W_NVDAX = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5;
    address internal constant ROUTER = 0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA;
    address internal constant QUOTER = 0xD1b797D92d87B688193A2B976eFc8D577D204343;
    address internal constant UNIVERSAL_ROUTER = 0xDa00aE15d3A71466517129255255db7c0c0956d3;

    uint256 internal constant USD = 1e6;
    uint256 internal constant DAILY_CAP = 100 * USD;

    XorrDelegation internal del;
    address internal owner = makeAddr("owner");
    address internal bot = makeAddr("bot");
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("XLAYER_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 196, "a fork of X Layer mainnet");
        forked = true;

        del = new XorrDelegation(USDC);
        deal(USDC, owner, 1_000 * USD);

        address[] memory venues = new address[](1);
        venues[0] = ROUTER;
        vm.startPrank(owner);
        IERC20Min(USDC).approve(address(del), type(uint256).max);
        IERC20Min(W_TSLAX).approve(address(del), type(uint256).max);
        IERC20Min(W_NVDAX).approve(address(del), type(uint256).max);
        del.grant(bot, DAILY_CAP, uint64(block.timestamp + 7 days), venues);
        vm.stopPrank();
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    /// The pool's own answer for this path and size, less 1% — the floor the executor would set.
    function _floor(bytes memory path, uint256 amountIn) internal returns (uint256) {
        (uint256 out,,,) = IQuoterV2(QUOTER).quoteExactInput(path, amountIn);
        assertGt(out, 0, "the pool quotes this route");
        return (out * 99) / 100;
    }

    function _swap(bytes memory path, uint256 amountIn, uint256 minOut) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            ISwapRouter02.exactInput.selector,
            ISwapRouter02.ExactInputParams({path: path, recipient: owner, amountIn: amountIn, amountOutMinimum: minOut})
        );
    }

    function test_BuysAWrappedXStockDirectlyAgainstUsdc() public onFork {
        bytes memory path = abi.encodePacked(USDC, uint24(500), W_TSLAX);
        uint256 minOut = _floor(path, 50 * USD);

        vm.prank(bot);
        del.spend(owner, USDC, ROUTER, 50 * USD, W_TSLAX, minOut, _swap(path, 50 * USD, minOut));

        assertGe(IERC20Min(W_TSLAX).balanceOf(owner), minOut, "the owner holds the wrapped xStock");
        assertEq(IERC20Min(USDC).balanceOf(owner), 950 * USD, "exactly $50 was spent");
        assertEq(del.spentToday(owner), 50 * USD, "the spend counts against the day");
        assertEq(IERC20Min(USDC).balanceOf(address(del)), 0, "the contract holds no USDC");
        assertEq(IERC20Min(W_TSLAX).balanceOf(address(del)), 0, "or any of the stock");
        assertEq(IERC20Min(USDC).allowance(address(del), ROUTER), 0, "and leaves no approval behind");
    }

    function test_BuysThroughTheUsdgHop() public onFork {
        bytes memory path = abi.encodePacked(USDC, uint24(100), USDG, uint24(500), W_NVDAX);
        uint256 minOut = _floor(path, 30 * USD);

        vm.prank(bot);
        del.spend(owner, USDC, ROUTER, 30 * USD, W_NVDAX, minOut, _swap(path, 30 * USD, minOut));

        assertGe(IERC20Min(W_NVDAX).balanceOf(owner), minOut, "the owner holds wrapped NVDAx");
    }

    function test_TheCapRefusesABuyPastTheDay() public onFork {
        bytes memory path = abi.encodePacked(USDC, uint24(500), W_TSLAX);
        uint256 minOut = _floor(path, 50 * USD);
        vm.prank(bot);
        del.spend(owner, USDC, ROUTER, 50 * USD, W_TSLAX, minOut, _swap(path, 50 * USD, minOut));

        uint256 minOut2 = _floor(path, 60 * USD);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.DailyCapExceeded.selector, 60 * USD, 50 * USD));
        del.spend(owner, USDC, ROUTER, 60 * USD, W_TSLAX, minOut2, _swap(path, 60 * USD, minOut2));
    }

    function test_AVenueTheOwnerDidNotAllowIsRefused() public onFork {
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.VenueNotAllowed.selector, UNIVERSAL_ROUTER));
        del.spend(owner, USDC, UNIVERSAL_ROUTER, 10 * USD, W_TSLAX, 1, hex"");
    }

    function test_ClosesAPositionBackToUsdc() public onFork {
        bytes memory buyPath = abi.encodePacked(USDC, uint24(500), W_TSLAX);
        uint256 minShares = _floor(buyPath, 50 * USD);
        vm.prank(bot);
        del.spend(owner, USDC, ROUTER, 50 * USD, W_TSLAX, minShares, _swap(buyPath, 50 * USD, minShares));

        uint256 shares = IERC20Min(W_TSLAX).balanceOf(owner);
        bytes memory sellPath = abi.encodePacked(W_TSLAX, uint24(500), USDC);
        uint256 minUsdc = _floor(sellPath, shares);
        uint256 usdcBefore = IERC20Min(USDC).balanceOf(owner);

        vm.prank(bot);
        del.closePosition(owner, W_TSLAX, ROUTER, shares, USDC, minUsdc, _swap(sellPath, shares, minUsdc));

        assertEq(IERC20Min(W_TSLAX).balanceOf(owner), 0, "the position is closed");
        assertGe(IERC20Min(USDC).balanceOf(owner) - usdcBefore, minUsdc, "the proceeds reached the owner");
        assertEq(del.spentToday(owner), 50 * USD, "a close never spends the cap");
    }

    function test_RevokingStopsTheBot() public onFork {
        vm.prank(owner);
        del.revoke();
        bytes memory path = abi.encodePacked(USDC, uint24(500), W_TSLAX);
        vm.prank(bot);
        vm.expectRevert(XorrDelegation.PolicyRevoked.selector);
        del.spend(owner, USDC, ROUTER, 10 * USD, W_TSLAX, 1, _swap(path, 10 * USD, 1));
    }
}
