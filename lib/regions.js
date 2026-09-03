// SPDX-License-Identifier: GPL-3.0-only
/**
 * Jurisdictions as data, not code.
 *
 * One row per Meshtastic firmware region: the airtime budget our pacing
 * mirrors, and where the number comes from. The firmware's own table
 * (src/mesh/RadioInterface.cpp) is the enforcement layer — these rows exist
 * so the courier paces itself to the same law the node will apply, and so a
 * new country is a data row, not a code change. Research thread with the
 * full table and sources:
 * https://github.com/NiKrause/libp2p-webrtc-qr-meshtastic/issues/1
 *
 * `dutyCycle` is the transmit budget as a fraction (0.1 = 6 min/hour);
 * null means the jurisdiction limits by other means (power, dwell time,
 * listen-before-talk) and pacing is not legally required — being a polite
 * mesh neighbour still is. Rows with `verify: true` are taken from the
 * firmware but not yet checked against the regulator's own text.
 */

export const REGIONS = {
  // EU-harmonised SRD framework (ETSI EN 300 220 / ERC 70-03); Germany via
  // BNetzA general authorisation. One row covers all 27 member states.
  EU_868: { dutyCycle: 0.1, framework: "ETSI EN 300 220 / ERC 70-03" },
  EU_866: { dutyCycle: 0.025, framework: "EU Decision 2006/771/EC (2.5 % mobile, 10 % fixed)" },
  EU_433: { dutyCycle: 0.1, framework: "ETSI EN 300 220 / ERC 70-03" },

  US: { dutyCycle: null, framework: "FCC Part 15.247" },
  BR_902: { dutyCycle: null, framework: "ANATEL Res. 680/2017" },
  RU: { dutyCycle: null, framework: "GKRCh decisions", verify: true },
  IN: { dutyCycle: null, framework: "WPC delicensed band" },
  CN: { dutyCycle: null, framework: "MIIT" },
  KZ_433: { dutyCycle: null, framework: "national allocation", verify: true },
  KZ_863: { dutyCycle: null, framework: "national allocation", verify: true },
  JP: { dutyCycle: null, framework: "ARIB STD-T108 (carrier sense + low power)" },
  KR: { dutyCycle: null, framework: "RRA" },
  TW: { dutyCycle: null, framework: "NCC" },
  ANZ: { dutyCycle: null, framework: "ACMA / RSM" },
  ANZ_433: { dutyCycle: null, framework: "ACMA / RSM" },
  NZ_865: { dutyCycle: null, framework: "RSM" },
  TH: { dutyCycle: 0.1, framework: "NBTC" },
  UA_433: { dutyCycle: 0.1, framework: "UCRF", verify: true },
  UA_868: { dutyCycle: 0.1, framework: "UCRF", verify: true },
  MY_433: { dutyCycle: null, framework: "MCMC" },
  MY_919: { dutyCycle: null, framework: "MCMC" },
  SG_923: { dutyCycle: null, framework: "IMDA" },
  PH_433: { dutyCycle: null, framework: "NTC", verify: true },
  PH_868: { dutyCycle: null, framework: "NTC", verify: true },
  PH_915: { dutyCycle: null, framework: "NTC", verify: true },
  NP_865: { dutyCycle: null, framework: "NTA", verify: true },
};

/**
 * Pacing policy for a firmware region code.
 *
 * UNSET is not a region: a node that does not know where it stands must not
 * be transmitted through, so the caller gets `misconfigured: true` and the
 * most conservative budget on the table instead of none.
 *
 * @param {string} region Firmware region name, e.g. "EU_868"
 * @returns {{ region: string, dutyCycle: number|null, misconfigured: boolean, verify: boolean, framework: string|null }}
 */
export function regionPolicy(region) {
  if (!region || region === "UNSET" || !REGIONS[region]) {
    return {
      region: region || "UNSET",
      dutyCycle: 0.025,
      misconfigured: true,
      verify: true,
      framework: null,
    };
  }
  const row = REGIONS[region];
  return {
    region,
    dutyCycle: row.dutyCycle,
    misconfigured: false,
    verify: Boolean(row.verify),
    framework: row.framework,
  };
}
