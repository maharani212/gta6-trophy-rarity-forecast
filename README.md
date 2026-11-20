# GTA VI Trophy Rarity Forecast

Forecast, for every Grand Theft Auto VI trophy on PlayStation 5, its earn rate
on Exophase at 2026-11-26T00:00:00Z, as five quantiles per trophy.

Entry for make.fun competition `gta6-trophy-rarity-forecast-01`.

## Program

`main.ts` (Node 22, standard library only). It reads every `<id>.in` in the
input directory (`$MAKEFUN_INPUT_DIR`, else `/input`) and writes `<id>.out`
to the output directory (`$MAKEFUN_OUTPUT_DIR`, else `/output`).

Run locally:

```
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Method

Per trophy, fit a straight line to logit(earn rate) against ln(1 + hours
since the first read) by least squares, and read the line at the target for
the median. The spread widens with the horizon like a random walk on the
logit scale, plus the fit's residual scatter. When the history is flat (every
read the same rate), Exophase has not refreshed yet, so the median is hedged
down and a wide band is used: a refresh dilutes rates as the tracked-player
base jumps. A trophy at 100% stays at 100%.
