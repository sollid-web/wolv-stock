// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IWOLVUSDT {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IWOLVSpotAdapter {
    function swapExactUsdtForToken(
        address tokenizedAsset,
        uint256 usdtAmount,
        uint256 minTokenOut,
        uint256 deadline
    ) external returns (uint256 tokenOut);
}

interface IWOLVPerpetualAdapter {
    function openShort(
        address tokenizedAsset,
        uint256 marginUsdt,
        uint256 assetAmount
    ) external returns (uint256 shortAssetAmount);
}

interface IWOLVLendingMarket {
    function repayBorrow(uint256 repayAmount) external returns (uint256 errorCode);
}

contract WOLVAdvancedStrategyVault {
    address public constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    uint256 public constant BSC_MAINNET_CHAIN_ID = 56;
    uint256 public constant MAX_SWAP_DEADLINE = 5 minutes;

    address public owner;
    address public executor;
    bool public paused;
    uint256 private _entered = 1;

    mapping(address => bool) public supportedAsset;
    mapping(address => address) public spotAdapterFor;
    mapping(address => address) public perpetualAdapterFor;
    mapping(address => bool) public approvedLendingMarket;

    error Unauthorized();
    error ZeroAddress();
    error UnsupportedChain(uint256 chainId);
    error ReentrantCall();
    error Paused();
    error InvalidAmount();
    error InsufficientUsdt(uint256 requested, uint256 available);
    error UnsupportedAsset(address asset);
    error InvalidAdapter(address adapter);
    error InvalidLendingMarket(address market);
    error InvalidDeadline(uint256 deadline);
    error InvalidTokenOutput(uint256 reported, uint256 received, uint256 minimum);
    error UsdtAccountingMismatch(uint256 expected, uint256 actual);
    error UnexpectedUsdtIncrease(uint256 beforeBalance, uint256 afterBalance);
    error HedgeAmountMismatch(uint256 expected, uint256 actual);
    error RepaymentFailed(uint256 errorCode);
    error NoRepaymentMade();
    error TokenCallFailed(address token);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ExecutorUpdated(address indexed previousExecutor, address indexed newExecutor);
    event PausedUpdated(bool paused);
    event AssetSupportUpdated(address indexed asset, bool supported);
    event DeltaAdaptersUpdated(
        address indexed asset,
        address indexed spotAdapter,
        address indexed perpetualAdapter
    );
    event LendingMarketUpdated(address indexed market, bool approved);
    event DeltaNeutralAllocationExecuted(
        address indexed asset,
        uint256 totalUsdtAmount,
        uint256 spotUsdtAmount,
        uint256 perpetualMarginUsdt,
        uint256 tokenAmount
    );
    event EmergencyMarginRepaid(
        address indexed lendingMarket,
        uint256 requestedAmount,
        uint256 repaidAmount
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier nonReentrant() {
        if (_entered != 1) revert ReentrantCall();
        _entered = 2;
        _;
        _entered = 1;
    }

    modifier onlyBscMainnet() {
        if (block.chainid != BSC_MAINNET_CHAIN_ID) revert UnsupportedChain(block.chainid);
        _;
    }

    constructor(address initialExecutor) {
        if (initialExecutor == address(0)) revert ZeroAddress();
        owner = msg.sender;
        executor = initialExecutor;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ExecutorUpdated(address(0), initialExecutor);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function setExecutor(address newExecutor) external onlyOwner {
        if (newExecutor == address(0)) revert ZeroAddress();
        address previousExecutor = executor;
        executor = newExecutor;
        emit ExecutorUpdated(previousExecutor, newExecutor);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedUpdated(paused_);
    }

    function setAssetSupport(address asset, bool supported) external onlyOwner {
        if (asset == address(0)) revert ZeroAddress();
        if (asset == USDT) revert UnsupportedAsset(asset);
        if (supported && asset.code.length == 0) revert UnsupportedAsset(asset);
        supportedAsset[asset] = supported;
        emit AssetSupportUpdated(asset, supported);
    }

    function setDeltaAdapters(
        address asset,
        address spotAdapter,
        address perpetualAdapter
    ) external onlyOwner {
        if (!supportedAsset[asset]) revert UnsupportedAsset(asset);
        if (spotAdapter == address(0) || spotAdapter.code.length == 0) {
            revert InvalidAdapter(spotAdapter);
        }
        if (perpetualAdapter == address(0) || perpetualAdapter.code.length == 0) {
            revert InvalidAdapter(perpetualAdapter);
        }
        spotAdapterFor[asset] = spotAdapter;
        perpetualAdapterFor[asset] = perpetualAdapter;
        emit DeltaAdaptersUpdated(asset, spotAdapter, perpetualAdapter);
    }

    function setLendingMarketApproval(address market, bool approved) external onlyOwner {
        if (market == address(0)) revert ZeroAddress();
        if (approved && market.code.length == 0) revert InvalidLendingMarket(market);
        approvedLendingMarket[market] = approved;
        emit LendingMarketUpdated(market, approved);
    }

    function executeDeltaNeutralAllocation(
        address tokenizedAsset,
        uint256 totalUsdtAmount,
        uint256 minTokenOut,
        uint256 deadline
    )
        external
        onlyBscMainnet
        onlyExecutor
        whenNotPaused
        nonReentrant
        returns (uint256 tokenAmount)
    {
        if (!supportedAsset[tokenizedAsset]) revert UnsupportedAsset(tokenizedAsset);
        if (minTokenOut == 0 || totalUsdtAmount < 2) revert InvalidAmount();
        if (
            deadline <= block.timestamp ||
            deadline > block.timestamp + MAX_SWAP_DEADLINE
        ) revert InvalidDeadline(deadline);

        address spotAdapter = spotAdapterFor[tokenizedAsset];
        address perpetualAdapter = perpetualAdapterFor[tokenizedAsset];
        if (spotAdapter == address(0)) revert InvalidAdapter(spotAdapter);
        if (perpetualAdapter == address(0)) revert InvalidAdapter(perpetualAdapter);

        uint256 usdtBefore = IWOLVUSDT(USDT).balanceOf(address(this));
        if (totalUsdtAmount > usdtBefore) {
            revert InsufficientUsdt(totalUsdtAmount, usdtBefore);
        }

        uint256 spotUsdtAmount = totalUsdtAmount / 2;
        uint256 perpetualMarginUsdt = totalUsdtAmount - spotUsdtAmount;

        tokenAmount = _executeSpotLeg(
            tokenizedAsset,
            spotAdapter,
            spotUsdtAmount,
            minTokenOut,
            deadline
        );
        _executePerpetualLeg(
            tokenizedAsset,
            perpetualAdapter,
            perpetualMarginUsdt,
            tokenAmount
        );

        uint256 usdtAfter = IWOLVUSDT(USDT).balanceOf(address(this));
        if (usdtAfter > usdtBefore) {
            revert UnexpectedUsdtIncrease(usdtBefore, usdtAfter);
        }
        uint256 actualUsdtSpent = usdtBefore - usdtAfter;
        if (actualUsdtSpent != totalUsdtAmount) {
            revert UsdtAccountingMismatch(totalUsdtAmount, actualUsdtSpent);
        }

        emit DeltaNeutralAllocationExecuted(
            tokenizedAsset,
            totalUsdtAmount,
            spotUsdtAmount,
            perpetualMarginUsdt,
            tokenAmount
        );
    }

    function _executeSpotLeg(
        address tokenizedAsset,
        address spotAdapter,
        uint256 usdtAmount,
        uint256 minTokenOut,
        uint256 deadline
    ) private returns (uint256 tokenAmount) {
        uint256 tokenBefore = IWOLVUSDT(tokenizedAsset).balanceOf(address(this));
        _safeApprove(USDT, spotAdapter, usdtAmount);
        uint256 reportedTokenOut = IWOLVSpotAdapter(spotAdapter).swapExactUsdtForToken(
            tokenizedAsset,
            usdtAmount,
            minTokenOut,
            deadline
        );
        _safeApprove(USDT, spotAdapter, 0);

        uint256 tokenAfter = IWOLVUSDT(tokenizedAsset).balanceOf(address(this));
        tokenAmount = tokenAfter - tokenBefore;
        if (reportedTokenOut != tokenAmount || tokenAmount < minTokenOut) {
            revert InvalidTokenOutput(reportedTokenOut, tokenAmount, minTokenOut);
        }
    }

    function _executePerpetualLeg(
        address tokenizedAsset,
        address perpetualAdapter,
        uint256 marginUsdt,
        uint256 tokenAmount
    ) private {
        _safeApprove(USDT, perpetualAdapter, marginUsdt);
        uint256 hedgedAmount = IWOLVPerpetualAdapter(perpetualAdapter).openShort(
            tokenizedAsset,
            marginUsdt,
            tokenAmount
        );
        _safeApprove(USDT, perpetualAdapter, 0);
        if (hedgedAmount != tokenAmount) {
            revert HedgeAmountMismatch(tokenAmount, hedgedAmount);
        }
    }

    function triggerEmergencyMarginRepay(
        address lendingPool,
        uint256 repayAmount
    )
        external
        onlyBscMainnet
        onlyExecutor
        whenNotPaused
        nonReentrant
        returns (uint256 repaidAmount)
    {
        if (!approvedLendingMarket[lendingPool]) {
            revert InvalidLendingMarket(lendingPool);
        }
        if (repayAmount == 0) revert InvalidAmount();

        uint256 usdtBefore = IWOLVUSDT(USDT).balanceOf(address(this));
        if (repayAmount > usdtBefore) revert InsufficientUsdt(repayAmount, usdtBefore);

        _safeApprove(USDT, lendingPool, repayAmount);
        uint256 errorCode = IWOLVLendingMarket(lendingPool).repayBorrow(repayAmount);
        _safeApprove(USDT, lendingPool, 0);
        if (errorCode != 0) revert RepaymentFailed(errorCode);

        uint256 usdtAfter = IWOLVUSDT(USDT).balanceOf(address(this));
        if (usdtAfter >= usdtBefore) revert NoRepaymentMade();
        repaidAmount = usdtBefore - usdtAfter;
        if (repaidAmount > repayAmount) {
            revert UsdtAccountingMismatch(repayAmount, repaidAmount);
        }

        emit EmergencyMarginRepaid(lendingPool, repayAmount, repaidAmount);
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        _callOptionalReturn(token, abi.encodeCall(IWOLVUSDT.approve, (spender, 0)));
        if (amount != 0) {
            _callOptionalReturn(token, abi.encodeCall(IWOLVUSDT.approve, (spender, amount)));
        }
    }

    function _callOptionalReturn(address token, bytes memory data) private {
        (bool success, bytes memory result) = token.call(data);
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TokenCallFailed(token);
        }
    }
}
