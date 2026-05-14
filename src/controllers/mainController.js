const mainService = require('../services/mainService');

async function analyzeUsersPortfolio(req, res, next) {
    try {
        const { portfolio, crisis } = req.body || {};

        // nearest trading day after crisis started
        const nearestTradingDay = mainService.getNearestTradingDay(crisis?.startDate);

        // current share prices of each portfolio item
        const currentAdjustedClosePrices = await mainService.fetchCurrentAdjustedClosePrices(
            portfolio
        );

        // full historical daily prices of all tickers in portfolio
        const historicalAdjustedCloseSeries =
            await mainService.fetchHistoricalAdjustedCloseSeries({
                portfolio,
                startDate: nearestTradingDay,
                endDate: crisis?.endDate
            });

        const companySectorResolutions = await mainService.fetchCompanySectorResolutions({
            portfolio,
            historicalAdjustedCloseSeries,
            startDate: nearestTradingDay,
            endDate: crisis?.endDate
        });

        // etf resolution for stocks
        const sectorEtfFallbackSeries = await mainService.fetchSectorEtfFallbackSeries({
            companySectorResolutions,
            startDate: nearestTradingDay,
            endDate: crisis?.endDate
        });

        // Fall back to SPY for ETF holdings that do not have enough historical data.
        const etfSpyFallbackSeries = await mainService.fetchEtfSpyFallbackSeries({
            portfolio,
            historicalAdjustedCloseSeries,
            startDate: nearestTradingDay,
            endDate: crisis?.endDate
        });

        const result = await mainService.analyzeUsersPortfolio({
            portfolio,
            crisis,
            nearestTradingDay,
            currentAdjustedClosePrices,
            historicalAdjustedCloseSeries,
            companySectorResolutions,
            sectorEtfFallbackSeries,
            etfSpyFallbackSeries
        });

        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
}

async function getAiSimpleFix(req, res, next) {
    try {
        const { portfolio, crisis, analysisSummary } = req.body || {};

        const result = await mainService.getAiSimpleFix({
            portfolio,
            crisis,
            analysisSummary
        });

        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
}

module.exports = {
    analyzeUsersPortfolio,
    getAiSimpleFix
};