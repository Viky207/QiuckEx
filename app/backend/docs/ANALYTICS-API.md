# Analytics API Documentation

## Overview

The Analytics API provides aggregated usage and financial metrics for the Developer Portal, offering insights into payment volume, success rates, active links, and asset breakdowns over specified time periods.

### Key Features

- **Time-series aggregation** for volume, fees, and success rates
- **Flexible granularity**: Daily, weekly, or monthly metrics
- **Asset breakdown** showing per-asset performance
- **Period comparisons** to track growth and trends
- **High performance**: Optimized queries respond within 500ms
- **Organization scoping**: Data automatically filtered to authenticated organization
- **Caching**: 5-minute cache on aggregations reduces database load

## Endpoints

### 0. Get Per-Username Earnings

**Endpoint**: `GET /analytics/:username/earnings`

**Description**: Aggregates payment data for a single username by time period so the frontend dashboard can render earnings-over-time charts. Data is sourced from the Horizon transaction history (no separate DB aggregation table for the MVP).

**Authentication**: Required. Only the owner of `:username` may request their own analytics; requests for another user's username return `403 Forbidden`.

**Query Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `period` | string | No | `day` | Bucket granularity: `day`, `week`, or `month` |
| `from` | ISO 8601 | No | 30 days ago | Range start (inclusive) |
| `to` | ISO 8601 | No | now | Range end (inclusive) |

**Constraints**:

- The requested range is capped at a maximum of **366 days**; larger ranges return `400 Bad Request`.
- `from` must be earlier than `to`.

**Caching**: Results are cached in Redis keyed by username, period, and range:

| `period` | TTL |
|----------|-----|
| `day` | 60s |
| `week` | 300s |
| `month` | 900s |

**Response Format**:

```json
[
  {
    "date": "2026-04-01",
    "total_xlm": "150.5000000",
    "total_usdc": "200.2500000",
    "tx_count": 11
  },
  {
    "date": "2026-04-02",
    "total_xlm": "200.2500000",
    "total_usdc": "0.0000000",
    "tx_count": 14
  }
]
```

Each element represents one bucket (`date` is the bucket start in `YYYY-MM-DD` form). `total_xlm` and `total_usdc` are decimal strings; `tx_count` is the number of successful transactions in the bucket.

**HTTP Status Codes**:

- `200 OK`: Successfully retrieved earnings
- `400 Bad Request`: Invalid `period`, invalid ISO 8601 dates, `from >= to`, or range exceeding 366 days
- `401 Unauthorized`: Missing or invalid credentials
- `403 Forbidden`: Authenticated user is not the owner of `:username`
- `500 Internal Server Error`: Server error

**Example Requests**:

```bash
# Daily earnings for the last 30 days (defaults)
curl -X GET "http://localhost:3000/analytics/alice/earnings?period=day" \
  -H "Authorization: Bearer your-token"

# Weekly earnings for a bounded range
curl -X GET "http://localhost:3000/analytics/alice/earnings?period=week&from=2026-04-01T00:00:00Z&to=2026-04-30T23:59:59Z" \
  -H "Authorization: Bearer your-token"

# Monthly earnings for the full year
curl -X GET "http://localhost:3000/analytics/alice/earnings?period=month&from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z" \
  -H "Authorization: Bearer your-token"
```

---

### 1. Get Aggregated Statistics

**Endpoint**: `GET /analytics/stats`

**Description**: Returns time-series metrics for a specified date range, grouped by the requested granularity.

**Query Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startDate` | ISO 8601 | Yes | - | Period start date (e.g., `2026-04-01T00:00:00Z`) |
| `endDate` | ISO 8601 | Yes | - | Period end date (e.g., `2026-04-30T23:59:59Z`) |
| `grouping` | string | No | `daily` | Time granularity: `daily`, `weekly`, or `monthly` |
| `assets` | string | No | - | Comma-separated asset codes to filter (e.g., `XLM,USDC`) |
| `breakdownByAsset` | boolean | No | `false` | Include per-asset breakdown in results |
| `includeComparison` | boolean | No | `false` | Include comparison with previous period |
| `includeZeros` | boolean | No | `false` | Include zero-value data points in time series |

**Response Format**:

```json
{
  "summary": {
    "period": "2026-04-01T00:00:00Z",
    "totalVolume": "5000.7500000",
    "totalFees": "0.0005000",
    "successRate": 92.3,
    "totalActiveLinks": 120,
    "totalPaidLinks": 108,
    "averageTransaction": "42.3100000",
    "transactionCount": 118,
    "assetBreakdown": [
      {
        "asset": "XLM",
        "volume": "3000.5000000",
        "fees": "0.0002500",
        "successRate": 94.2,
        "activeLinks": 75,
        "paidLinks": 68,
        "averageTransaction": "40.5400000",
        "transactionCount": 74
      },
      {
        "asset": "USDC:GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ6KUVNNBI5I7AD3H",
        "volume": "2000.2500000",
        "fees": "0.0002500",
        "successRate": 89.5,
        "activeLinks": 45,
        "paidLinks": 40,
        "averageTransaction": "44.5000000",
        "transactionCount": 44
      }
    ],
    "comparison": {
      "previousPeriod": "2026-03-01T00:00:00Z",
      "volumeChangePercent": 15.2,
      "successRateChangePercent": 2.5,
      "activeLinksChangePercent": 8.3,
      "paidLinksChangePercent": 12.1,
      "averageTransactionChangePercent": -5.5,
      "transactionCountChange": 35
    }
  },
  "timeSeries": [
    {
      "period": "2026-04-01T00:00:00Z",
      "totalVolume": "150.5000000",
      "totalFees": "0.0001500",
      "successRate": 91.2,
      "totalActiveLinks": 12,
      "totalPaidLinks": 11,
      "averageTransaction": "13.6800000",
      "transactionCount": 11
    },
    {
      "period": "2026-04-02T00:00:00Z",
      "totalVolume": "200.2500000",
      "totalFees": "0.0002000",
      "successRate": 93.5,
      "totalActiveLinks": 15,
      "totalPaidLinks": 14,
      "averageTransaction": "14.3000000",
      "transactionCount": 14
    }
  ],
  "metadata": {
    "requestedStartDate": "2026-04-01T00:00:00Z",
    "requestedEndDate": "2026-04-30T23:59:59Z",
    "granularity": "daily",
    "assetFilter": ["XLM", "USDC:GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ6KUVNNBI5I7AD3H"],
    "generatedAt": "2026-04-28T15:30:45.123Z",
    "executionTimeMs": 187
  }
}
```

**HTTP Status Codes**:

- `200 OK`: Successfully retrieved statistics
- `400 Bad Request`: Invalid date format, date range, or other validation error
- `401 Unauthorized`: Missing or invalid API key
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Example Requests**:

```bash
# Basic aggregated stats for April 2026 (daily granularity)
curl -X GET "http://localhost:3000/analytics/stats?startDate=2026-04-01T00:00:00Z&endDate=2026-04-30T23:59:59Z" \
  -H "X-API-Key: your-api-key"

# Weekly stats with asset breakdown
curl -X GET "http://localhost:3000/analytics/stats?startDate=2026-04-01T00:00:00Z&endDate=2026-04-30T23:59:59Z&grouping=weekly&breakdownByAsset=true" \
  -H "X-API-Key: your-api-key"

# XLM only with comparison to previous period
curl -X GET "http://localhost:3000/analytics/stats?startDate=2026-04-01T00:00:00Z&endDate=2026-04-30T23:59:59Z&assets=XLM&includeComparison=true" \
  -H "X-API-Key: your-api-key"

# Monthly stats for full year with breakdowns
curl -X GET "http://localhost:3000/analytics/stats?startDate=2026-01-01T00:00:00Z&endDate=2026-12-31T23:59:59Z&grouping=monthly&breakdownByAsset=true" \
  -H "X-API-Key: your-api-key"
```

---

### 2. Compare Periods

**Endpoint**: `GET /analytics/stats/comparison`

**Description**: Returns side-by-side comparison of current period with the equivalent previous period, showing percentage changes for all metrics.

**Query Parameters**: Same as `/analytics/stats` (minus `includeComparison` flag)

**Response Format**:

```json
{
  "current": {
    "period": "2026-04-15T00:00:00Z",
    "totalVolume": "3500.0000000",
    "totalFees": "0.0003500",
    "successRate": 94.5,
    "totalActiveLinks": 85,
    "totalPaidLinks": 78,
    "averageTransaction": "44.8700000",
    "transactionCount": 78,
    "assetBreakdown": [
      {
        "asset": "XLM",
        "volume": "2400.0000000",
        "fees": "0.0002400",
        "successRate": 95.8,
        "activeLinks": 55,
        "paidLinks": 52,
        "averageTransaction": "46.1500000",
        "transactionCount": 52
      },
      {
        "asset": "USDC:GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ6KUVNNBI5I7AD3H",
        "volume": "1100.0000000",
        "fees": "0.0001100",
        "successRate": 91.7,
        "activeLinks": 30,
        "paidLinks": 26,
        "averageTransaction": "42.3000000",
        "transactionCount": 26
      }
    ]
  },
  "previous": {
    "period": "2026-04-08T00:00:00Z",
    "totalVolume": "3000.0000000",
    "totalFees": "0.0003000",
    "successRate": 91.2,
    "totalActiveLinks": 78,
    "totalPaidLinks": 71,
    "averageTransaction": "42.2500000",
    "transactionCount": 71,
    "assetBreakdown": []
  },
  "comparison": {
    "previousPeriod": "2026-04-08T00:00:00Z",
    "volumeChangePercent": 16.67,
    "successRateChangePercent": 3.3,
    "activeLinksChangePercent": 8.97,
    "paidLinksChangePercent": 9.86,
    "averageTransactionChangePercent": 6.13,
    "transactionCountChange": 7
  },
  "metadata": {
    "generatedAt": "2026-04-28T15:30:45.123Z",
    "executionTimeMs": 234
  }
}
```

**Example Requests**:

```bash
# Compare current week vs previous week
curl -X GET "http://localhost:3000/analytics/stats/comparison?startDate=2026-04-22T00:00:00Z&endDate=2026-04-28T23:59:59Z&grouping=weekly" \
  -H "X-API-Key: your-api-key"

# Compare current month vs previous month
curl -X GET "http://localhost:3000/analytics/stats/comparison?startDate=2026-04-01T00:00:00Z&endDate=2026-04-30T23:59:59Z&grouping=monthly&breakdownByAsset=true" \
  -H "X-API-Key: your-api-key"
```

---

## Metrics Reference

### Volume (`totalVolume` / `volume`)
- **Definition**: Sum of all transaction amounts in the period
- **Unit**: Asset units (e.g., XLM, USDC)
- **Notes**: Only counts successful transactions

### Fees (`totalFees` / `fees`)
- **Definition**: Total transaction fees paid
- **Unit**: XLM (Stellar's native asset)
- **Notes**: Includes Horizon API fees and network fees

### Success Rate (`successRate`)
- **Definition**: Percentage of transactions that completed successfully
- **Formula**: `(successful_transactions / total_transactions) * 100`
- **Range**: 0–100%
- **Notes**: Only counts transactions that reached a terminal state
