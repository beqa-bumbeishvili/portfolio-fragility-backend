const assert = require('node:assert/strict');
const test = require('node:test');

const mainController = require('../src/controllers/mainController');

const originalFetch = global.fetch;
const originalApiToken = process.env.EODHD_API_TOKEN;

test.after(() => {
	global.fetch = originalFetch;

	if (originalApiToken === undefined) {
		delete process.env.EODHD_API_TOKEN;
		return;
	}

	process.env.EODHD_API_TOKEN = originalApiToken;
});

test('hypothetical mode is deterministic for the same input', async () => {
	process.env.EODHD_API_TOKEN = 'test-token';
	global.fetch = createMockFetch({
		pricesBySymbol: {
			QQQ: { adjustedClose: 100, date: '2026-08-31' }
		},
		historyPresetsBySymbol: {
			QQQ: { startPrice: 84, dailyReturnStep: 0.011 }
		}
	});

	const body = buildHypotheticalBody({
		portfolio: [{ symbol: 'QQQ', quantity: 5, type: 'etf' }]
	});
	const firstResult = await invokeAnalyzeUsersPortfolio(body);
	const secondResult = await invokeAnalyzeUsersPortfolio(body);

	assert.deepStrictEqual(secondResult, firstResult);
	assert.equal(firstResult.payload.series.length > 0, true);
});

test('realtime price endpoint returns the latest close for a symbol', async () => {
	process.env.EODHD_API_TOKEN = 'test-token';
	global.fetch = createMockFetch({
		realTimeQuotesBySymbol: {
			TQQQ: {
				code: 'TQQQ.US',
				timestamp: 1778876880,
				open: 50.1,
				high: 51.2,
				low: 49.4,
				close: 50.23,
				volume: 54620573,
				previousClose: 48.21,
				change: 2.02,
				change_p: 4.1892
			}
		}
	});

	const result = await invokeGetRealtimePrice({
		body: { symbol: 'tqqq' }
	});

	assert.deepStrictEqual(result, {
		statusCode: 200,
		payload: {
			ok: true,
			symbol: 'TQQQ',
			code: 'TQQQ.US',
			price: 50.23,
			timestamp: 1778876880,
			previousClose: 48.21,
			change: 2.02,
			changePercent: 4.1892
		}
	});
});

test('realtime price endpoint requires a symbol', async () => {
	const result = await invokeGetRealtimePrice();

	assert.deepStrictEqual(result, {
		statusCode: 400,
		payload: {
			ok: false,
			error: 'A symbol is required.'
		}
	});
});

test('special ETF behavior makes TQQQ follow 3x compounded QQQ daily returns', async () => {
	process.env.EODHD_API_TOKEN = 'test-token';
	global.fetch = createMockFetch({
		pricesBySymbol: {
			QQQ: { adjustedClose: 100, date: '2026-08-31' },
			TQQQ: { adjustedClose: 50, date: '2026-08-31' }
		},
		historyPresetsBySymbol: {
			QQQ: { startPrice: 84, dailyReturnStep: 0.011 },
			TQQQ: { startPrice: 44, dailyReturnStep: 0.028 }
		}
	});

	const qqqResult = await invokeAnalyzeUsersPortfolio(
		buildHypotheticalBody({
			portfolio: [{ symbol: 'QQQ', quantity: 1, type: 'etf' }]
		})
	);
	const tqqqResult = await invokeAnalyzeUsersPortfolio(
		buildHypotheticalBody({
			portfolio: [{ symbol: 'TQQQ', quantity: 1, type: 'etf' }]
		})
	);
	const qqqFinalReturn = qqqResult.payload.series[qqqResult.payload.series.length - 1].cumulativeReturn;
	const tqqqFinalReturn = tqqqResult.payload.series[tqqqResult.payload.series.length - 1].cumulativeReturn;
	const expectedTqqqSeries = buildExpectedLeveragedPortfolioSeries({
		underlyingSeries: qqqResult.payload.series,
		startValue: 50,
		leverageMultiplier: 3
	});

	assert.equal(tqqqFinalReturn < qqqFinalReturn, true);
	assertPortfolioSeriesClose(tqqqResult.payload.series, expectedTqqqSeries);
	assert.deepStrictEqual(tqqqResult.payload.warnings, []);
	assert.deepStrictEqual(tqqqResult.payload.analysisSummary.fallbackUsage, []);
});

test('single-stock hypothetical path keeps its endpoint but has jagged daily movement', async () => {
	const aaplHistoricalSeries = buildExplicitHistoricalSeries({
		startDate: '2026-04-13',
		adjustedCloses: [100, 95, 101, 97, 104, 98, 106, 100, 108, 103, 110, 104]
	});
	const xlkHistoricalSeries = buildExplicitHistoricalSeries({
		startDate: '2026-04-13',
		adjustedCloses: [100, 99, 100.5, 99.8, 101, 100.2, 101.4, 100.8, 101.8, 101.1, 102, 101.5]
	});

	process.env.EODHD_API_TOKEN = 'test-token';
	global.fetch = createMockFetch({
		pricesBySymbol: {
			AAPL: { adjustedClose: 200, date: '2026-08-31' }
		},
		fundamentalsBySymbol: {
			AAPL: {
				Sector: 'Technology',
				Industry: 'Consumer Electronics',
				Type: 'Common Stock'
			}
		},
		historySeriesBySymbol: {
			AAPL: aaplHistoricalSeries,
			XLK: xlkHistoricalSeries
		}
	});

	const result = await invokeAnalyzeUsersPortfolio(
		buildHypotheticalBody({
			portfolio: [{ symbol: 'AAPL', quantity: 1, type: 'stock' }]
		})
	);
	const dailyReturns = result.payload.series.slice(1).map((point) => point.dailyReturn);
	const expectedSensitivityScore = calculateExpectedSensitivityScore({
		historicalSeries: aaplHistoricalSeries,
		benchmarkSeries: xlkHistoricalSeries
	});

	assert.equal(dailyReturns.some((dailyReturn) => dailyReturn > 0), true);
	assert.equal(dailyReturns.some((dailyReturn) => dailyReturn < 0), true);
	assert.equal(
		result.payload.series[result.payload.series.length - 1].cumulativeReturn,
		roundMetric(-0.55 * expectedSensitivityScore)
	);
	assert.deepStrictEqual(result.payload.warnings, []);
});

test('custom headline timeline changes timing while preserving the endpoint', async () => {
	const aaplHistoricalSeries = buildExplicitHistoricalSeries({
		startDate: '2026-04-13',
		adjustedCloses: [100, 95, 101, 97, 104, 98, 106, 100, 108, 103, 110, 104]
	});
	const xlkHistoricalSeries = buildExplicitHistoricalSeries({
		startDate: '2026-04-13',
		adjustedCloses: [100, 99, 100.5, 99.8, 101, 100.2, 101.4, 100.8, 101.8, 101.1, 102, 101.5]
	});
	const headlines = [
		'AI hype fades, valuations plummet',
		'Tech layoffs surge as AI projects stall',
		'AI startups face funding crunch',
		'Mega-cap tech stocks lead market decline',
		'AI chip demand collapses, supply chain hit'
	];

	process.env.EODHD_API_TOKEN = 'test-token';
	global.fetch = createMockFetch({
		pricesBySymbol: {
			AAPL: { adjustedClose: 200, date: '2026-08-31' }
		},
		fundamentalsBySymbol: {
			AAPL: {
				Sector: 'Technology',
				Industry: 'Consumer Electronics',
				Type: 'Common Stock'
			}
		},
		historySeriesBySymbol: {
			AAPL: aaplHistoricalSeries,
			XLK: xlkHistoricalSeries
		}
	});

	const earlyTimelineResult = await invokeAnalyzeUsersPortfolio(
		buildHypotheticalBody({
			portfolio: [{ symbol: 'AAPL', quantity: 1, type: 'stock' }],
			crisis: {
				shape: 'cliff',
				headlines,
				headlineTimeline: headlines.map((headline, index) => ({
					headline,
					position: [0.02, 0.08, 0.16, 0.28, 0.4][index]
				}))
			}
		})
	);
	const lateTimelineResult = await invokeAnalyzeUsersPortfolio(
		buildHypotheticalBody({
			portfolio: [{ symbol: 'AAPL', quantity: 1, type: 'stock' }],
			crisis: {
				shape: 'cliff',
				headlines,
				headlineTimeline: headlines.map((headline, index) => ({
					headline,
					position: [0.26, 0.42, 0.58, 0.74, 0.9][index]
				}))
			}
		})
	);
	const comparisonIndex = Math.max(1, Math.floor(earlyTimelineResult.payload.series.length * 0.25));
	const earlySeries = earlyTimelineResult.payload.series;
	const lateSeries = lateTimelineResult.payload.series;

	assert.equal(
		earlySeries[comparisonIndex].cumulativeReturn < lateSeries[comparisonIndex].cumulativeReturn,
		true
	);
	assert.equal(
		earlySeries[earlySeries.length - 1].cumulativeReturn,
		lateSeries[lateSeries.length - 1].cumulativeReturn
	);
});

test('custom overshoot window changes where the deepest extra dip happens', async () => {
	const aaplHistoricalSeries = buildExplicitHistoricalSeries({
		startDate: '2026-04-13',
		adjustedCloses: [100, 95, 101, 97, 104, 98, 106, 100, 108, 103, 110, 104]
	});
	const xlkHistoricalSeries = buildExplicitHistoricalSeries({
		startDate: '2026-04-13',
		adjustedCloses: [100, 99, 100.5, 99.8, 101, 100.2, 101.4, 100.8, 101.8, 101.1, 102, 101.5]
	});
	const headlines = [
		'AI hype fades, valuations plummet',
		'Tech layoffs surge as AI projects stall',
		'AI startups face funding crunch',
		'Mega-cap tech stocks lead market decline',
		'AI chip demand collapses, supply chain hit'
	];
	const headlineTimeline = headlines.map((headline, index) => ({
		headline,
		position: [0.08, 0.24, 0.42, 0.6, 0.78][index]
	}));

	process.env.EODHD_API_TOKEN = 'test-token';
	global.fetch = createMockFetch({
		pricesBySymbol: {
			AAPL: { adjustedClose: 200, date: '2026-08-31' }
		},
		fundamentalsBySymbol: {
			AAPL: {
				Sector: 'Technology',
				Industry: 'Consumer Electronics',
				Type: 'Common Stock'
			}
		},
		historySeriesBySymbol: {
			AAPL: aaplHistoricalSeries,
			XLK: xlkHistoricalSeries
		}
	});

	const earlyOvershootResult = await invokeAnalyzeUsersPortfolio(
		buildHypotheticalBody({
			portfolio: [{ symbol: 'AAPL', quantity: 1, type: 'stock' }],
			crisis: {
				shape: 'cliff',
				headlines,
				headlineTimeline,
				overshootWindow: {
					start: 0.12,
					peak: 0.22,
					end: 0.38
				}
			}
		})
	);
	const lateOvershootResult = await invokeAnalyzeUsersPortfolio(
		buildHypotheticalBody({
			portfolio: [{ symbol: 'AAPL', quantity: 1, type: 'stock' }],
			crisis: {
				shape: 'cliff',
				headlines,
				headlineTimeline,
				overshootWindow: {
					start: 0.52,
					peak: 0.68,
					end: 0.86
				}
			}
		})
	);
	const earlySeries = earlyOvershootResult.payload.series;
	const lateSeries = lateOvershootResult.payload.series;
	const earlyComparisonIndex = Math.max(1, Math.floor(earlySeries.length * 0.22));
	const lateComparisonIndex = Math.max(1, Math.floor(earlySeries.length * 0.7));

	assert.equal(
		earlySeries[earlyComparisonIndex].cumulativeReturn < lateSeries[earlyComparisonIndex].cumulativeReturn,
		true
	);
	assert.equal(
		lateSeries[lateComparisonIndex].cumulativeReturn < earlySeries[lateComparisonIndex].cumulativeReturn,
		true
	);
	assert.equal(
		earlySeries[earlySeries.length - 1].cumulativeReturn,
		lateSeries[lateSeries.length - 1].cumulativeReturn
	);
});

test('invalid headline timeline falls back to the default spacing logic', async () => {
	const aaplHistoricalSeries = buildExplicitHistoricalSeries({
		startDate: '2026-04-13',
		adjustedCloses: [100, 95, 101, 97, 104, 98, 106, 100, 108, 103, 110, 104]
	});
	const xlkHistoricalSeries = buildExplicitHistoricalSeries({
		startDate: '2026-04-13',
		adjustedCloses: [100, 99, 100.5, 99.8, 101, 100.2, 101.4, 100.8, 101.8, 101.1, 102, 101.5]
	});
	const headlines = [
		'AI hype fades, valuations plummet',
		'Tech layoffs surge as AI projects stall',
		'AI startups face funding crunch',
		'Mega-cap tech stocks lead market decline',
		'AI chip demand collapses, supply chain hit'
	];

	process.env.EODHD_API_TOKEN = 'test-token';
	global.fetch = createMockFetch({
		pricesBySymbol: {
			AAPL: { adjustedClose: 200, date: '2026-08-31' }
		},
		fundamentalsBySymbol: {
			AAPL: {
				Sector: 'Technology',
				Industry: 'Consumer Electronics',
				Type: 'Common Stock'
			}
		},
		historySeriesBySymbol: {
			AAPL: aaplHistoricalSeries,
			XLK: xlkHistoricalSeries
		}
	});

	const defaultResult = await invokeAnalyzeUsersPortfolio(
		buildHypotheticalBody({
			portfolio: [{ symbol: 'AAPL', quantity: 1, type: 'stock' }],
			crisis: {
				shape: 'cliff',
				headlines
			}
		})
	);
	const invalidTimelineResult = await invokeAnalyzeUsersPortfolio(
		buildHypotheticalBody({
			portfolio: [{ symbol: 'AAPL', quantity: 1, type: 'stock' }],
			crisis: {
				shape: 'cliff',
				headlines,
				headlineTimeline: [
					{
						position: -0.1,
						headline: headlines[0]
					}
				]
			}
		})
	);

	assert.deepStrictEqual(invalidTimelineResult.payload.series, defaultResult.payload.series);
});

test('unknown ETF defaults to broad_etf with a clear fallback reason', async () => {
	process.env.EODHD_API_TOKEN = 'test-token';
	global.fetch = createMockFetch({
		pricesBySymbol: {
			MYST: { adjustedClose: 50, date: '2026-08-31' },
			SPY: { adjustedClose: 500, date: '2026-08-31' }
		},
		historyPresetsBySymbol: {
			MYST: { startPrice: 46, dailyReturnStep: 0.008 },
			SPY: { startPrice: 470, dailyReturnStep: 0.004 }
		}
	});

	const result = await invokeAnalyzeUsersPortfolio(
		buildHypotheticalBody({
			portfolio: [{ symbol: 'MYST', quantity: 2, type: 'etf' }]
		})
	);

	assert.deepStrictEqual(result.payload.analysisSummary.fallbackUsage, [
		{
			symbol: 'MYST',
			used: true,
			source: 'broad_etf',
			holdingType: 'etf',
			requestedBucket: null,
			resolvedBucket: 'broad_etf',
			reason: 'missing_etf_category'
		}
	]);
	assert.deepStrictEqual(result.payload.warnings, [
		'MYST defaulted to broad_etf for the hypothetical scenario because its ETF category was not mapped.'
	]);
});

test('missing stock sector data defaults to broad_etf with a clear fallback reason', async () => {
	process.env.EODHD_API_TOKEN = 'test-token';
	global.fetch = createMockFetch({
		pricesBySymbol: {
			AAPL: { adjustedClose: 200, date: '2026-08-31' },
			SPY: { adjustedClose: 500, date: '2026-08-31' }
		},
		fundamentalsBySymbol: {
			AAPL: {}
		},
		historyPresetsBySymbol: {
			AAPL: { startPrice: 182, dailyReturnStep: 0.012 },
			SPY: { startPrice: 470, dailyReturnStep: 0.004 }
		}
	});

	const result = await invokeAnalyzeUsersPortfolio(
		buildHypotheticalBody({
			portfolio: [{ symbol: 'AAPL', quantity: 2, type: 'stock' }]
		})
	);

	assert.deepStrictEqual(result.payload.analysisSummary.fallbackUsage, [
		{
			symbol: 'AAPL',
			used: true,
			source: 'broad_etf',
			holdingType: 'stock',
			requestedBucket: null,
			resolvedBucket: 'broad_etf',
			reason: 'missing_stock_sector'
		}
	]);
	assert.deepStrictEqual(result.payload.warnings, [
		'AAPL defaulted to broad_etf for the hypothetical scenario because its stock sector lookup was unavailable.'
	]);
});

test('endDate before startDate falls back to a single trading day instead of failing', async () => {
	process.env.EODHD_API_TOKEN = 'test-token';
	global.fetch = createMockFetch({
		pricesBySymbol: {
			QQQ: { adjustedClose: 100, date: '2026-08-31' }
		},
		historyPresetsBySymbol: {
			QQQ: { startPrice: 84, dailyReturnStep: 0.011 }
		}
	});

	const result = await invokeAnalyzeUsersPortfolio(
		buildHypotheticalBody({
			portfolio: [{ symbol: 'QQQ', quantity: 1, type: 'etf' }],
			crisis: {
				startDate: '2026-09-15',
				endDate: '2026-09-01'
			}
		})
	);

	assert.equal(result.payload.series.length, 1);
	assert.equal(result.payload.series[0].date, '2026-09-15');
	assert.equal(result.payload.summary.tradingDays, 1);
});

function buildHypotheticalBody({ portfolio, crisis = {} }) {
	return {
		portfolio,
		crisis: {
			id: 'ai_bubble_burst',
			label: 'AI Bubble Burst',
			group: 'hypothetical',
			startDate: '2026-09-01',
			endDate: '2027-01-19',
			shape: 'slow_grind',
			headlines: [
				'AI hype fades, valuations plummet',
				'Tech layoffs surge as AI projects stall',
				'AI startups face funding crunch',
				'Mega-cap tech stocks lead market decline',
				'Markets stabilize after emergency support'
			],
			sectorShocks: {
				tech: -0.55,
				financials: -0.22,
				energy: -0.12,
				consumer: -0.2,
				healthcare: -0.1,
				industrials: -0.25,
				communications: -0.42,
				broad_etf: -0.32,
				tech_etf: -0.6,
				bond_etf: 0.06
			},
			...crisis
		}
	};
}

function createMockFetch({
	pricesBySymbol = {},
	realTimeQuotesBySymbol = {},
	fundamentalsBySymbol = {},
	historySeriesBySymbol = {},
	historyPresetsBySymbol = {}
} = {}) {
	return async function mockFetch(url) {
		const requestUrl = normalizeMockFetchUrl(url);

		if (requestUrl.pathname.includes('/api/real-time/')) {
			const symbol = requestUrl.pathname.split('/').pop().replace('.US', '').toUpperCase();

			return buildJsonResponse(realTimeQuotesBySymbol[symbol] || {}, realTimeQuotesBySymbol[symbol] ? 200 : 404);
		}

		if (requestUrl.pathname.endsWith('/eod-bulk-last-day/US')) {
			const requestedSymbols = (requestUrl.searchParams.get('symbols') || '')
				.split(',')
				.map((symbol) => symbol.trim().toUpperCase())
				.filter(Boolean);

			return buildJsonResponse(
				requestedSymbols
					.filter((symbol) => pricesBySymbol[symbol])
					.map((symbol) => ({
						code: symbol,
						adjusted_close: pricesBySymbol[symbol].adjustedClose,
						date: pricesBySymbol[symbol].date
					}))
			);
		}

		if (requestUrl.pathname.includes('/api/fundamentals/')) {
			const symbol = requestUrl.pathname.split('/').pop().toUpperCase();

			return buildJsonResponse(fundamentalsBySymbol[symbol] || {});
		}

		if (requestUrl.pathname.includes('/api/eod/')) {
			const symbol = requestUrl.pathname.split('/').pop().replace('.US', '').toUpperCase();
			const fromDate = requestUrl.searchParams.get('from');
			const toDate = requestUrl.searchParams.get('to');
			const explicitHistoricalSeries = historySeriesBySymbol[symbol];
			const historyPreset = historyPresetsBySymbol[symbol] || {
				startPrice: 100,
				dailyReturnStep: 0.005
			};

			if (Array.isArray(explicitHistoricalSeries) && explicitHistoricalSeries.length > 0) {
				return buildJsonResponse(
					filterHistoricalRecordsByDate({
						records: explicitHistoricalSeries,
						fromDate,
						toDate
					})
				);
			}

			return buildJsonResponse(
				buildHistoricalRecords({
					fromDate,
					toDate,
					startPrice: historyPreset.startPrice,
					dailyReturnStep: historyPreset.dailyReturnStep
				})
			);
		}

		throw new Error(`Unexpected mocked fetch URL: ${requestUrl.toString()}`);
	};
}

function normalizeMockFetchUrl(url) {
	if (typeof url === 'string') {
		return new URL(url);
	}

	if (url instanceof URL) {
		return url;
	}

	if (url && typeof url.url === 'string') {
		return new URL(url.url);
	}

	throw new TypeError(`Unsupported mocked fetch input: ${String(url)}`);
}

function buildExplicitHistoricalSeries({ startDate, adjustedCloses }) {
	if (!Array.isArray(adjustedCloses) || adjustedCloses.length === 0) {
		return [];
	}

	const records = [];
	const cursorDate = new Date(`${startDate}T00:00:00Z`);
	let adjustedCloseIndex = 0;

	while (adjustedCloseIndex < adjustedCloses.length) {
		const dayOfWeek = cursorDate.getUTCDay();

		if (dayOfWeek !== 0 && dayOfWeek !== 6) {
			records.push({
				date: cursorDate.toISOString().slice(0, 10),
				adjusted_close: adjustedCloses[adjustedCloseIndex]
			});

			adjustedCloseIndex += 1;
		}

		cursorDate.setUTCDate(cursorDate.getUTCDate() + 1);
	}

	return records;
}

function filterHistoricalRecordsByDate({ records, fromDate, toDate }) {
	return records.filter(
		(record) =>
			typeof record?.date === 'string' &&
			record.date >= fromDate &&
			record.date <= toDate
	);
}

function buildHistoricalRecords({ fromDate, toDate, startPrice, dailyReturnStep }) {
	const records = [];
	const cursorDate = new Date(`${fromDate}T00:00:00Z`);
	const lastDate = new Date(`${toDate}T00:00:00Z`);
	let currentPrice = startPrice;
	let dayIndex = 0;

	while (cursorDate.getTime() <= lastDate.getTime()) {
		const dayOfWeek = cursorDate.getUTCDay();

		if (dayOfWeek !== 0 && dayOfWeek !== 6) {
			const drift = 1 + dailyReturnStep * (1 + (dayIndex % 5) / 10);

			records.push({
				date: cursorDate.toISOString().slice(0, 10),
				adjusted_close: Number(currentPrice.toFixed(4))
			});

			currentPrice *= drift;
			dayIndex += 1;
		}

		cursorDate.setUTCDate(cursorDate.getUTCDate() + 1);
	}

	return records;
}

function buildJsonResponse(jsonBody, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		async json() {
			return jsonBody;
		}
	};
}

function calculateExpectedSensitivityScore({ historicalSeries, benchmarkSeries }) {
	const historicalVolatility = calculateSeriesVolatility(historicalSeries);
	const benchmarkVolatility = calculateSeriesVolatility(benchmarkSeries);

	if (
		typeof historicalVolatility !== 'number' ||
		typeof benchmarkVolatility !== 'number' ||
		benchmarkVolatility <= 0
	) {
		return 1;
	}

	return clampNumber(historicalVolatility / benchmarkVolatility, 0.8, 1.2);
}

function calculateSeriesVolatility(series) {
	const dailyReturns = getAdjustedCloseDailyReturns(series);

	if (dailyReturns.length === 0) {
		return null;
	}

	const averageReturn =
		dailyReturns.reduce((sum, dailyReturn) => sum + dailyReturn, 0) / dailyReturns.length;
	const variance =
		dailyReturns.reduce(
			(sum, dailyReturn) => sum + (dailyReturn - averageReturn) ** 2,
			0
		) / dailyReturns.length;

	return Math.sqrt(variance);
}

function getAdjustedCloseDailyReturns(series) {
	if (!Array.isArray(series) || series.length < 2) {
		return [];
	}

	const dailyReturns = [];

	for (let index = 1; index < series.length; index += 1) {
		const previousAdjustedClose = series[index - 1]?.adjusted_close;
		const currentAdjustedClose = series[index]?.adjusted_close;

		if (
			typeof previousAdjustedClose !== 'number' ||
			typeof currentAdjustedClose !== 'number' ||
			previousAdjustedClose <= 0
		) {
			continue;
		}

		dailyReturns.push((currentAdjustedClose - previousAdjustedClose) / previousAdjustedClose);
	}

	return dailyReturns;
}

function clampNumber(value, minimumValue, maximumValue) {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		return minimumValue;
	}

	return Math.min(Math.max(value, minimumValue), maximumValue);
}

function roundMetric(value) {
	return Number(value.toFixed(4));
}

function roundCurrency(value) {
	return Number(value.toFixed(2));
}

function buildExpectedLeveragedPortfolioSeries({
	underlyingSeries,
	startValue,
	leverageMultiplier
}) {
	if (!Array.isArray(underlyingSeries) || underlyingSeries.length === 0) {
		return [];
	}

	const leveragedSeries = [];
	let peakValue = startValue;

	for (let index = 0; index < underlyingSeries.length; index += 1) {
		if (index === 0) {
			leveragedSeries.push({
				date: underlyingSeries[index].date,
				portfolioValue: startValue,
				dailyReturn: 0,
				cumulativeReturn: 0,
				drawdown: 0
			});
			continue;
		}

		const previousValue = leveragedSeries[index - 1].portfolioValue;
		const leveragedDailyReturn = roundMetric(
			(underlyingSeries[index].dailyReturn || 0) * leverageMultiplier
		);
		const portfolioValue = roundCurrency(previousValue * Math.max(0, 1 + leveragedDailyReturn));

		peakValue = Math.max(peakValue, portfolioValue);

		leveragedSeries.push({
			date: underlyingSeries[index].date,
			portfolioValue,
			dailyReturn:
				previousValue === 0 ? 0 : roundMetric((portfolioValue - previousValue) / previousValue),
			cumulativeReturn:
				startValue === 0 ? 0 : roundMetric((portfolioValue - startValue) / startValue),
			drawdown:
				peakValue === 0 ? 0 : roundMetric((portfolioValue - peakValue) / peakValue)
		});
	}

	return leveragedSeries;
}

function assertPortfolioSeriesClose(actualSeries, expectedSeries) {
	assert.equal(actualSeries.length, expectedSeries.length);

	for (let index = 0; index < actualSeries.length; index += 1) {
		assert.equal(actualSeries[index].date, expectedSeries[index].date);
		assert.equal(
			Math.abs(actualSeries[index].portfolioValue - expectedSeries[index].portfolioValue) <= 0.02,
			true
		);
		assert.equal(
			Math.abs(actualSeries[index].dailyReturn - expectedSeries[index].dailyReturn) <= 0.002,
			true
		);
		assert.equal(
			Math.abs(actualSeries[index].cumulativeReturn - expectedSeries[index].cumulativeReturn) <= 0.002,
			true
		);
		assert.equal(
			Math.abs(actualSeries[index].drawdown - expectedSeries[index].drawdown) <= 0.002,
			true
		);
	}
}

function invokeAnalyzeUsersPortfolio(body) {
	return new Promise((resolve, reject) => {
		const req = { body };
		const res = {
			statusCode: 200,
			status(code) {
				this.statusCode = code;
				return this;
			},
			json(payload) {
				resolve({
					statusCode: this.statusCode,
					payload
				});
			}
		};

		mainController.analyzeUsersPortfolio(req, res, reject);
	});
}

function invokeGetRealtimePrice({ body = {}, params = {}, query = {} } = {}) {
	return new Promise((resolve, reject) => {
		const req = { body, params, query };
		const res = {
			statusCode: 200,
			status(code) {
				this.statusCode = code;
				return this;
			},
			json(payload) {
				resolve({
					statusCode: this.statusCode,
					payload
				});
			}
		};

		mainController.getRealtimePrice(req, res, reject);
	});
}