# Price Forecasting

This document describes how the app predicts future fuel prices, why those
techniques were chosen, and how the pieces map to the code in `app.js`.

All computations run in the browser in plain JavaScript — no frameworks, no
build step, no external math libraries.

## Overview

Given a daily price series (national average or a single station), the app:

1. Evaluates several candidate models with **out-of-sample backtesting**.
2. Picks the model with the lowest error.
3. Projects the chosen model forward over the requested horizon.
4. Draws a **confidence band** that widens with the horizon.
5. Reports a **reliability** label derived from the real prediction error.

The entry point is `buildForecast(series, forecastDays, reference)`, where
`reference` is an optional national series used to anchor a single station's
forecast. It returns:

```js
{
  points: [{ date, value, lower, upper }, ...],  // one per forecast day
  model:  "naive" | "linear" | "holt" | "anchored", // winner of the backtest
  rmse:   Number,                                // out-of-sample RMSE of the winner
  scores: { naive, linear, holt, anchored? },    // RMSE of each candidate
  slope:  Number                                 // next-day change vs. last real value
}
```

## Models

### 1. Naive / persistence (`naiveForecast`)

The simplest possible model: tomorrow equals today (`forecast = last value`).
For a single station this is often the **hardest baseline to beat**: station
prices are mostly flat and change in occasional discrete jumps, so any
trend-following model tends to overshoot. Including naive in the pool prevents
the app from inventing a downward/upward slope that is not really there.

### 2. Recency-weighted linear regression (`linearForecast`)

Ordinary least squares fits a straight line to the data, but treats a point
from three weeks ago the same as yesterday. Fuel prices change regime, so we
weight recent observations more heavily.

- `linearRegression(values, weights)` performs **weighted least squares (WLS)**.
  With no weights it reduces to ordinary least squares.
- `recencyWeights(n, halfLife = 10)` builds exponentially decaying weights:
  the most recent point has weight 1, and weight halves every `halfLife` days
  (`w_age = exp(-ln(2)/halfLife * age)`).
- `linearForecast(values, horizon, fitWindow)` fits the weighted line over the
  last `fitWindow` points (capped at 21) and extrapolates it.

Best when the trend is roughly straight. Degrades when the curve bends.

### 3. Double exponential smoothing — Holt (`holtForecast`)

Holt's method tracks two quantities that update as new data arrives:

- **Level** `l`: the current baseline price.
- **Trend** `b`: the current rate of change.

```
level_t = α · value_t + (1 − α) · (level_{t−1} + trend_{t−1})
trend_t = β · (level_t − level_{t−1}) + (1 − β) · trend_{t−1}
forecast_{t+k} = level_t + k · trend_t
```

Smoothing factors default to `α = 0.5`, `β = 0.3`. Because the level and trend
adapt continuously, Holt reacts to changes in direction faster than a
fixed-window regression. It tends to win on the smoother national series.

### 4. National anchoring (`anchoredForecast`)

Only available for a single station, and only when a national `reference`
series is supplied. A given station usually tracks the national market with a
roughly constant offset, so instead of forecasting the noisy station directly
we:

1. Align the station and national series by date (`alignByDate`).
2. Compute the recent **spread** = station − national, using the **median** of
   the last ~10 overlapping days for robustness.
3. Forecast the smoother **national trend** with Holt.
4. Add the spread back: `forecast = nationalForecast + spread`.

This borrows the statistical strength of hundreds of stations (the national
average) and only models the stable local difference. It needs at least 8
overlapping days; otherwise it is skipped and the other models are used.

## Model selection: one-step backtesting (`backtestOneStep`)

We do **not** pick a model by in-sample fit (e.g. R²), because in-sample fit
rewards overfitting and says nothing about future accuracy. Instead we simulate
real forecasting with a rolling origin:

1. Reserve the last `testSize` points as a validation set
   (`testSize ≈ 30%` of the series, clamped to `[5, 14]`).
2. Walking forward through the validation set, for each point train the model
   **only on prior data** and predict one step ahead.
3. Compare predictions to actual values and compute the **RMSE**
   (root mean squared error) via `rmse(actual, predicted)`.

The candidate with the lowest out-of-sample RMSE wins (requiring at least 3
valid comparisons). This RMSE is an honest estimate of how wrong the next-day
prediction tends to be. If the series is too short for a conclusive backtest,
the app falls back to the **naive** model.

## Confidence band

A single predicted number hides uncertainty. `buildForecast` returns `lower`
and `upper` bounds for each forecast day using an approximate 95% interval:

```
margin_k = 1.96 · σ · √k
lower = value − margin_k
upper = value + margin_k
```

where `σ` is the winning model's out-of-sample RMSE (falling back to the
standard deviation of recent values if the backtest was inconclusive on very
short series). The `√k` factor makes the band widen with the horizon, reflecting
that errors accumulate the further ahead we look. The band is rendered in
`drawChart` as a translucent fill anchored at the last real point (zero margin).

## Reliability label

`renderMetrics` converts the error into a human label using the RMSE relative to
the current price:

| Relative RMSE (`rmse / price`) | Label      |
| ------------------------------ | ---------- |
| ≤ 0.4%                         | alta/high  |
| ≤ 1%                           | media/med  |
| otherwise                      | baja/low   |

The prediction card also shows which model was selected and the error band
(`±RMSE €/L`).

## Code map (`app.js`)

| Function             | Responsibility                                            |
| -------------------- | --------------------------------------------------------- |
| `naiveForecast`      | Persistence baseline (tomorrow = today)                   |
| `linearRegression`   | Weighted/ordinary least squares, returns slope/intercept  |
| `recencyWeights`     | Exponentially decaying weights for WLS                    |
| `linearForecast`     | Recency-weighted linear extrapolation                     |
| `holtForecast`       | Double exponential smoothing (level + trend)              |
| `alignByDate`        | Aligns two {date, value} series on common dates           |
| `anchoredForecast`   | Station = national trend + recent median spread           |
| `rmse`               | Root mean squared error of two aligned arrays             |
| `backtestOneStep`    | Rolling-origin one-step-ahead out-of-sample RMSE          |
| `buildForecast`      | Selects the model, projects it, builds confidence band    |
| `renderMetrics`      | Shows prediction, reliability, chosen model and error     |
| `drawChart`          | Draws history, SMA, forecast line and confidence band     |

## Verification

The pure functions were validated against real data from the API:

- On the national `gasoline_95` series (90 days), backtesting selected **Holt**
  (RMSE ≈ 0.0033 €/L) over linear (≈ 0.0048 €/L). The 7-day projection was
  monotonic and realistic, and the confidence band at day 7 was about
  ±0.017 €/L, wider than at day 1, as expected.
- Across 8 real Madrid stations, model selection adapted per station:
  **naive** won on 5 (flat/stepwise price series), **Holt** on 1 (a genuine
  local trend), and **anchored** on 2 (stations that closely track the national
  market, RMSE ≈ 0.005 €/L). This confirms the pool picks the right tool per
  case instead of forcing a single model.

## Possible future improvements

- **Seasonal decomposition**: remove weekly/seasonal components before fitting
  (could use the monthly endpoint `/v1/history/monthly`).
- **Jump-aware uncertainty**: for stepwise station series, estimate the band
  from the frequency and size of price jumps rather than the mean RMSE.
- **Parameter tuning**: grid-search `α`/`β` for Holt and `halfLife` for the
  weights by minimizing backtest RMSE.
- **Date-gap awareness**: index points by real dates so missing days don't
  distort the per-day slope.
