// Exchange rates for providers that price in another currency. One place, so two adapters that
// bill in the same currency can't drift apart. They are approximate; set `pricing` (and
// `freeTier`) in config to match your invoice exactly.

/**
 * US dollars per euro: the ECB euro reference rate for USD, 1.0990 on 2026-11-20
 * (https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/eurofxref-graph-usd.en.html).
 * Used by `boxd`, `briq` and `watasu`.
 */
export const USD_PER_EUR = 1.099;

/** Chinese yuan per US dollar, approximate as of 2026-11-21. Used by `tencent`, `volcengine` and `rayrun`. */
export const CNY_PER_USD = 7.1;

/**
 * Indian rupees per US dollar, from the ECB euro reference rates of 2026-11-20 (INR 101.85 and
 * USD 1.0990 per euro, https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml): ≈ 92.67.
 * Used by `voidrun`.
 */
export const INR_PER_USD = 101.85 / USD_PER_EUR;
