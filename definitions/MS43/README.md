# MS43 Gauge.S definitions (DS2 telegram)

Gauge.S configs for the Siemens MS43 (M54, E46/E39/E53/E85/E83), built from the
RomRaider logger definitions in [Rustle333/Siemens-MS43](https://github.com/Rustle333/Siemens-MS43).
They are compared below against the stock Gauge.S
[`definitions-old/MS43_std.json`](https://github.com/handmade0octopus/gauge.s-sorek.uk/blob/master/definitions-old/MS43_std.json).

| File | Software | Load scale |
| --- | --- | --- |
| `MS43_430069_telegram.json` | 430069 (7551615), the latest and most common | 0.021194781 mg/str |
| `MS43_430069_ext_telegram.json` | 430069 flashed with the ms4x extended-load binary | 0.04239 mg/str, VANOS intake at `0x40212` |
| `MS43_430056_telegram.json` | 430056 (7519308 / 7545150) | 0.021194781 mg/str |
| `MS43_std.json` | 430069 or 430056, stock `0x0B 0x03` block; known-good fallback | 0.021194781 mg/str |

Copy the file for your software onto the Gauge.S SD card as `config.json`, or
merge its `address` and `ecuparam` into your existing one. Where the analyzer
in this repo has a matching channel, the header uses a name it recognises
(`Engine Speed`, `Knock Correction`, `Lambda Int 1`, `Ignition Angle`,
`Battery Voltage`, …). No other header is mistaken for one of its channels.
`Vanos Intake` keeps its usual Gauge.S name, which the analyzer's cam-advance
channel does not match.

## How it works

`MS43_std.json` polls DS2 `0x0B 0x03`, a fixed status block that the ECU
defines, and picks bytes out of it by `offset`. Rustle333's logger instead
uses the **telegram** mode that ba114 found. The tester first sends the ECU a
list of RAM addresses (`0x0B 0x01`) and then repeatedly polls `0x0B 0x00`. The
ECU answers with exactly those values, in that order. Gauge.S supports this
mode directly, as used by the MS41 definitions:

- main `"address"` is the poll, `["0x12", "0x05", "0x0B", "0x00", "0x1C"]`
- each parameter's `"address"` is `0x<type><32-bit address>`, with type
  `00` = byte, `01` = word, `02` = ADC procedure; the firmware builds the
  set-up frame and works out every offset itself

This lets the gauge read any RAM value the RomRaider logger can. That covers
per-cylinder timing, knock correction, long-term trims, MAP and gear, none of
which the `0x0B 0x03` block contains.

Frame budget: 47 parameters make a 241-byte set-up frame, and DS2's limit is
255, so there is room for at most 2 more. The response is 84 bytes, so expect
roughly 8–10 Hz at 9600 baud. Every entry is polled even when `hidden`, so
delete any you do not need if you want a faster refresh rate.

## Comparison with `MS43_std.json`

### Scaling problems in `MS43_std.json`

| Parameter | `MS43_std.json` | RomRaider (Rustle333) | Effect |
| --- | --- | --- | --- |
| Ambient Pressure | `mul 0.001202675`, unit `mbar` | hPa = `x*0.08291626`, psi = `x*0.001202599` | The factor is RomRaider's **psi** factor, so the value shows ~14.5 labelled mbar |
| Vanos Intake | `mul 0.375`, no offset, unit `%` | `x*0.3745 + 60` °CRK | Reads 60° low |
| Vanos Exhaust | `mul -0.375`, no offset, range 0–255 | `x*-0.3745 - 60` °CRK | Reads 60° high, and every value is outside the graph range |
| Intake Air Temp | `0.75x - 48` | `0.747x - 48` | Under 0.5 °C difference |

These scalings match RomRaider: Engine Speed, Engine Load (0.0212),
Mass Airflow (0.25), Ignition Angle (`-0.375x + 72`), Fuel Inj (0.00533 ms),
Coolant (`0.75x - 48`), Oil (`0.796x - 48`), Lambda Int (`0.0015259x - 50`),
Vehicle Speed and Battery (the 8-bit 0.102 matches the 10-bit 0.025).

### Present in RomRaider but missing from `MS43_std.json`, now in the telegram files

- Per-cylinder ignition angle (cylinders 2–6), shown in the files as `Ignition Angle Cyl N`
- Knock correction (`E27`, `(x-128)*0.375`)
- Long-term fuel trims, multiplicative `LTFT 1/2` and additive `LTFT Add 1/2`
- RON (octane) adaptation
- Gear
- Calculated MAP and filtered load
- MAF, pre- and post-cat O2, TPS / TPS plausibility, pedal plausibility and knock-sensor voltages
- DMTL, fuel-cap and SAF voltages, plus the IAT / coolant / oil-temp sensor voltages

`MS43_std.json` in this folder is the gauge.s file with these scaling fixes
applied, plus the pedal unit/range and knock-sensor decimals.

### In `MS43_std.json` only

The following come from the `0x0B 0x03` block and have no RAM address in the
RomRaider logger, so they are **not** in the telegram files: radiator outlet
temp, IACV / idle actuator duty, catalyst-heater channels, cooling-fan duty
and the second battery reading. If you need them, keep using `MS43_std.json`,
because one config can poll only one DS2 request.

The RomRaider switch bits (`S0`–`S49`, from the `0x0B 0x04` status group) are
left out for the same reason. The RomRaider knock-adaptation index (`E99`)
comes from a separate `0x06` memory read and is left out too.

### Not carried over from the RomRaider logger

- `E101`/`E102` read the same ADC channels as the pre-cat O2 entries.
- `E108` is labelled "pedal request volts" but uses the battery-voltage formula.
- The `zz`/EGT debug values exist only on 430069 and are rarely wired.
- In the ext-load logger, ADC channels `0x19`/`0x1A`/DMTL/SAF are relabelled
  for custom sensors (oil pressure, LPFP, AFR, boost). The ext file keeps the
  stock O2/voltage meaning; change the `mul`/`add` if your car is wired that way.

## Check on the car before trusting

1. **ADC procedures (type `02`).** RomRaider reads them from MS43 as 2-byte
   10-bit values, so these files give them `"length": 2` and 10-bit scaling
   (`0.00488 V`, battery `0.025 V`). The MS41 Gauge.S files use 8-bit scaling
   for the same kind of entry. If `Battery Voltage` reads about 4× too high or
   is garbage, the firmware reads these as one byte: change their `mul` to
   `0.01952` (battery `0.101`). These entries are placed last on purpose, so
   the RAM values above them are unaffected either way.
2. **Telegram size.** If the gauge shows no data at all, the ECU or firmware
   may accept fewer than 47 entries. Delete hidden entries from the end of
   the list until it connects.
