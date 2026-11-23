import { expect, test } from "bun:test"
import type { AnyCircuitElement, PcbComponent } from "circuit-json"
import Papa from "papaparse"
import {
  convertCircuitJsonToPickAndPlaceCsv,
  convertCircuitJsonToPickAndPlaceRows,
  type PickAndPlaceRow,
  type PickAndPlaceRotationWarning,
} from "../src"
import recordedCircuit from "./assets/bottom-side-rotation.circuit.json"
import { renderBottomSideRotation } from "./fixtures/render-bottom-side-rotation"

// Geometry/identity records extracted without coordinate changes from the
// reporter's output/circuit.json in the attachment to:
// https://github.com/tscircuit/circuit-json-to-pnp-csv/issues/41
const fixture = recordedCircuit as AnyCircuitElement[]

const circuit = (
  overrides: Partial<PcbComponent> = {},
): AnyCircuitElement[] => [
  {
    type: "source_component",
    source_component_id: "source",
    ftype: "simple_chip",
    name: "U1",
  },
  {
    type: "pcb_component",
    pcb_component_id: "pcb",
    source_component_id: "source",
    center: { x: 12, y: -4 },
    footprint_origin: { x: 12.5, y: -4.25 },
    width: 3,
    height: 2,
    layer: "bottom",
    rotation: 90,
    obstructs_within_bounds: true,
    ...overrides,
  },
]

const metadataCases: {
  label: string
  offset: number
  metadata: Partial<PcbComponent>
}[] = [
  { label: "unverified", offset: 0, metadata: {} },
  {
    label: "zero offset",
    offset: 0,
    metadata: {
      pin1_location: "leftside_top",
      supplier_pin1_location_map: { jlcpcb: "leftside_top" },
    },
  },
  {
    label: "+90 offset",
    offset: 90,
    metadata: {
      pin1_location: "leftside_top",
      supplier_pin1_location_map: { jlcpcb: "topside_right" },
    },
  },
  {
    label: "-90 offset",
    offset: 270,
    metadata: {
      pin1_location: "leftside_top",
      supplier_pin1_location_map: { jlcpcb: "bottomside_left" },
    },
  },
]
const cases = [
  [90, 270],
  [270, 90],
  [-90, 90],
  [450, 270],
  [22.5, 337.5],
].flatMap(([rotation, mirrored]) =>
  metadataCases.flatMap((metadata) =>
    [false, true].map((flip_y_axis) => ({
      rotation,
      mirrored,
      flip_y_axis,
      ...metadata,
    })),
  ),
)

for (const {
  rotation,
  mirrored,
  flip_y_axis,
  metadata,
  offset,
  label,
} of cases) {
  test.failing(
    `Component-view hypothesis: bottom ${rotation} degrees, ${label}, flip=${flip_y_axis}`,
    () => {
      const input = circuit({ rotation, ...metadata })
      const original = structuredClone(input)
      const warnings: PickAndPlaceRotationWarning[] = []
      const opts = {
        supplier: "jlcpcb" as const,
        flip_y_axis,
        requireSupplierRotation: label !== "unverified",
        onRotationWarning: (warning: PickAndPlaceRotationWarning) =>
          warnings.push(warning),
      }
      const expectedRotation = (mirrored + offset) % 360
      expect(convertCircuitJsonToPickAndPlaceRows(input, opts)).toEqual([
        {
          designator: "U1",
          mid_x: 12.5,
          mid_y: flip_y_axis ? 4.25 : -4.25,
          layer: "bottom",
          rotation: expectedRotation,
        },
      ])
      expect(warnings).toHaveLength(label === "unverified" ? 1 : 0)
      expect(convertCircuitJsonToPickAndPlaceCsv(input, opts)).toBe(
        `Designator,Mid X,Mid Y,Layer,Rotation\r\nU1,12.500,${flip_y_axis ? "4.250" : "-4.250"},bottom,${expectedRotation}`,
      )
      expect(input).toEqual(original)
    },
  )
}

test.failing(
  "component-view hypothesis: recorded bottom/90 rows would export 270",
  () => {
    const rows = convertCircuitJsonToPickAndPlaceRows(fixture, {
      supplier: "jlcpcb",
      onRotationWarning: () => {},
    })
    expect(
      rows.map(({ designator, rotation }) => [designator, rotation]),
    ).toEqual([
      ["D1", 0],
      ["D2", 90],
      ["D3", 0],
      ["D4", 270],
      ["U1", 0],
      ["U2", 90],
      ["U3", 0],
      ["U4", 270],
    ])
  },
)

const unresolvedCases = [
  { reason: "missing_pin1_location", metadata: {} },
  {
    reason: "missing_supplier_pin1_location",
    metadata: { pin1_location: "leftside_top" },
  },
  {
    reason: "incompatible_pin1_locations",
    metadata: {
      pin1_location: "leftside_top",
      supplier_pin1_location_map: { jlcpcb: "leftside_bottom" },
    },
  },
] as const
for (const { reason, metadata } of unresolvedCases) {
  test.failing(`component-view fallback still diagnoses ${reason}`, () => {
    const warnings: PickAndPlaceRotationWarning[] = []
    const opts = {
      supplier: "jlcpcb" as const,
      onRotationWarning: (warning: PickAndPlaceRotationWarning) =>
        warnings.push(warning),
    }
    const input = circuit(metadata)
    expect(convertCircuitJsonToPickAndPlaceRows(input, opts)[0].rotation).toBe(
      270,
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      reason,
      designator: "U1",
      pcb_component_id: "pcb",
      supplier: "jlcpcb",
    })
    expect(warnings[0].message).toContain("270")
    expect(() =>
      convertCircuitJsonToPickAndPlaceCsv(input, {
        ...opts,
        requireSupplierRotation: true,
      }),
    ).toThrow(reason)
    expect(warnings).toHaveLength(1)
  })
}

test("top, generic and other-supplier angles retain their conventions", () => {
  for (const rotation of [-450, -90, 0, 90, 180, 270, 450, 22.5]) {
    for (const layer of ["top", "bottom"] as const) {
      const input = circuit({ rotation, layer })
      expect(convertCircuitJsonToPickAndPlaceRows(input)[0].rotation).toBe(
        rotation,
      )
      expect(
        convertCircuitJsonToPickAndPlaceRows(input, {
          supplier: "pcbway",
          onRotationWarning: () => {},
        })[0].rotation,
      ).toBe(rotation)
      if (layer === "top" || rotation === 0 || rotation === 180) {
        expect(
          convertCircuitJsonToPickAndPlaceRows(input, {
            supplier: "jlcpcb",
            onRotationWarning: () => {},
          })[0].rotation,
        ).toBe(rotation)
      }
      const verified = circuit({
        rotation,
        layer,
        pin1_location: "leftside_top",
        supplier_pin1_location_map: {
          pcbway: "topside_right",
          jlcpcb: "topside_right",
        },
      })
      const expected = (((rotation + 90) % 360) + 360) % 360
      expect(
        convertCircuitJsonToPickAndPlaceRows(verified, {
          supplier: "pcbway",
          requireSupplierRotation: true,
        })[0].rotation,
      ).toBe(expected)
      if (layer === "top")
        expect(
          convertCircuitJsonToPickAndPlaceRows(verified, {
            supplier: "jlcpcb",
            requireSupplierRotation: true,
          })[0].rotation,
        ).toBe(expected)
    }
  }
})

test("raw CSV placement over recorded pads", async () => {
  const csv = convertCircuitJsonToPickAndPlaceCsv(fixture, {
    supplier: "jlcpcb",
    onRotationWarning: () => {},
  })
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true })
  expect(parsed.errors).toEqual([])
  const rows: PickAndPlaceRow[] = parsed.data.map((row) => ({
    designator: row.Designator,
    mid_x: Number(row["Mid X"]),
    mid_y: Number(row["Mid Y"]),
    layer: row.Layer as "top" | "bottom",
    rotation: Number(row.Rotation),
  }))
  expect(rows).toEqual(
    convertCircuitJsonToPickAndPlaceRows(fixture, {
      supplier: "jlcpcb",
      onRotationWarning: () => {},
    }),
  )
  const svg = renderBottomSideRotation(fixture, rows)
  const snapshot = new URL(
    "./__snapshots__/bottom-side-rotation.snap.svg",
    import.meta.url,
  )
  if (process.env.BUN_UPDATE_SNAPSHOTS === "1") await Bun.write(snapshot, svg)
  expect(svg).toBe(await Bun.file(snapshot).text())
})
