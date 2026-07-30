# @pipeworx/dc-dmv

District of Columbia DMV data: service centers, the record-level **vehicle inspection** file,
and **traffic convictions**. Keyless.

## Why DC gets its own pack

DC's grain is unlike any state's. The District publishes **766,879 individual vehicle
inspections** keyed by VIN and **330,728 individual traffic convictions** keyed by citation,
both as ArcGIS tables on the DCGIS server — not the county-level aggregates most states
publish. So the tools take VINs, violation text and date ranges rather than a county argument.

## Tools

| Tool | What it returns |
|---|---|
| `dc_dmv_offices` | All 9 DMV locations — service centers, the inspection station, two self-service emissions kiosks, the Deanwood road-test/CDL center, and Adjudication Services |
| `dc_dmv_vehicle_inspections` | Inspection records by VIN or VIN prefix, with inspection and expiration dates; or inspection volume per month/year |
| `dc_dmv_convictions` | Traffic convictions counted by violation or court disposition, or individual citation records |

## Auth

None. Every upstream is a public DCGIS ArcGIS MapServer layer.

## The State Plane coordinate trap

**The office layer's `XCOORD`/`YCOORD` columns are Maryland State Plane metres, not lat/lng.**
Georgetown Service Center reads `394380.55, 137456.23` — plausible-looking numbers that are
wrong by the width of a hemisphere if treated as coordinates.

Every query here passes `geometry: true` to `arcgisQuery` (which sets `outSR=4326`) and reads
latitude and longitude off the **returned geometry**. `XCOORD`/`YCOORD` are deliberately left
out of the response so they cannot be mistaken for coordinates downstream. Georgetown's real
position is `38.9050, -77.0648`.

## Gotchas worth knowing

These are live-verified behaviours, not guesses:

- **The inspection file's `STATUS` column is empty on all 766,879 rows**, so a pass/fail
  outcome is *not* published. What you get is that an inspection happened, when, and when the
  resulting certificate expires — an expiration roughly two years out is the usual sign of a
  pass, a short one of a re-inspection window. The tool's `note` says so rather than letting a
  caller read a null as "unknown result". For per-test pass/fail with make and model,
  `nj_mvc_vehicle_inspections` publishes it.
- **`GIS_ID`, `CREATOR` and `CREATED` are also empty** on the inspection table.
- **About half the conviction rows prefix the violation text with a four-digit internal code** —
  `0201SPEED IN EXCESS OF LIMIT` and `SPEED IN EXCESS OF LIMIT` are the same offence in two
  buckets. A raw group-by therefore splits and mis-ranks every violation. The tool strips the
  prefix and merges: "DISOBEYING OFFICIAL SIGN OR SIGNAL DEVICE" is 20,113 convictions, not the
  10,369 a naive query reports.
- **DCGIS caps any single response at 2,000 rows**, grouped statistics included. Month and year
  rollups group by day upstream (1,874 distinct days across the whole file — inside the cap) and
  aggregate in code; if that ever hits the cap the response flags `truncated` and says to narrow
  with `inspected_since`.
- **Coverage:** inspections run 2020-11-01 → 2026-06-30 and are still being appended;
  convictions run 2002-07-01 → 2026-06-27. Both are returned in a `coverage` field rather than
  assumed.
- **Convictions are convictions.** A citation that was dismissed or never adjudicated is absent,
  so these counts are not ticket counts.
- **The office layer carries no ZIP and no hours.** `MATCHADDR` is the District's own geocoded
  street address; dmv.dc.gov posts hours per location.

## Available but not wrapped

The same `Transportation_DMV` MapServer carries further DMV tables that are queryable but not
exposed as tools:

| Layer | Table |
|---|---|
| 142 | DMV Business Information |
| 143 | DMV Driver License Information |
| 144 | DMV ID Card Information |
| 145 | DMV Reciprocity Parking Permit |
| 146 | DMV Personalized Plates |
| 147 | DMV Disability Placard |
| 149 | DMV Vehicle Inspections FY2003-2013 |
| 150 | DMV Vehicle Inspections FY2014-2020 |
| 166 | DMV Boot and Tow |

Layers 149 and 150 are the historical inspection archives and share the current table's schema,
including the same empty `STATUS`.

## Data sources

- [DCGIS Public_Service layer 4](https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Public_Service_WebMercator/MapServer/4) — District agency locations, filtered to the 9 DMV rows
- [DCGIS Transportation_DMV layer 1](https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Transportation_DMV_WebMercator/MapServer/1) — DMV Vehicle Inspections
- [DCGIS Transportation_DMV layer 151](https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Transportation_DMV_WebMercator/MapServer/151) — DMV Convictions
- Dataset discovery: [opendata.dc.gov](https://opendata.dc.gov/)

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "dc-dmv": {
      "url": "https://gateway.pipeworx.io/dc-dmv/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1392+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about District of Columbia DMV data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
