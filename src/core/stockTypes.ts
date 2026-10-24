/*
 * ROLLING STOCK (v0.3.38): the types of the stock library, fleet and rakes. Kept in their own module
 * so the stock code stays separable (rakes plan section 5); core/types.ts refers to them.
 *
 * Everything here is generic: a company, an era or a diagram number is only ever data (a class's
 * `origin`, `eras` and `diagram`), never a branch in code.
 */

/** What a vehicle is, broadly. Coaching stock also has a coach type. */
export type StockCategory = 'coach' | 'van' | 'wagon' | 'brakeVan' | 'other';

/**
 * Coaching stock types. Present = the vehicle is coaching stock (it runs in passenger, parcels and mail
 * trains); goods vans and wagons have none. 'van' is a non-passenger coaching van (parcels, luggage).
 */
export type CoachType = 'ordinary' | 'passengerBrake' | 'fullBrake' | 'drivingTrailer' | 'tpo' | 'catering' | 'sleeping' | 'van';

/**
 * How good a length is: measured (a diagram or museum record), estimated (worked out, e.g. over
 * headstocks plus the buffer allowance), nominal (basis unknown) or generic (a fallback type's
 * approximate value). Anything but measured is shown as approximate ("about").
 */
export type LengthBasis = 'measured' | 'estimated' | 'nominal' | 'generic';

/** A drawing hint for the visualiser. Absent = drawn from the category. */
export type StockShape = 'coach' | 'open' | 'mineral' | 'closed' | 'cattle' | 'tank' | 'flat' | 'brakeVan';

/** One type of vehicle in the library (built in, or added by the user). */
export interface VehicleClass {
  id: string;
  name: string;
  /** Short class code, e.g. BTK; used in the system identity of its vehicles (D3). */
  code?: string;
  category: StockCategory;
  coachType?: CoachType;
  /** Corridor (true; open/vestibule coaches count as corridor, D2) or non-corridor (false). Absent = not recorded. */
  corridor?: boolean;
  /** Has a guard's compartment (passenger brakes, full brakes, freight brake vans, driving brakes). */
  guard: boolean;
  /** Length over buffers in metres: the length measured against platforms and roads. Absent = not known. */
  metresOverBuffers?: number;
  /** Length over headstocks in metres (the figure diagrams quote), when known. */
  metresOverHeadstocks?: number;
  /** How good metresOverBuffers is. Absent only when the length is not known. */
  lengthBasis?: LengthBasis;
  /** A working continuous brake (vacuum or air). Unfitted = handbrake only. */
  fitted: boolean;
  /** Weights in kg, optional: tare (empty), and loaded for wagons and vans. */
  tareKg?: number;
  loadedKg?: number;
  /** How good the weights are (v0.3.41; the generic types carry generic weights). Absent with a weight = as typed. */
  weightBasis?: LengthBasis;
  shape?: StockShape;
  /** The company that built or owned the type (LMS, LNWR, GWR…, or 'generic'). Also picks its parameters. */
  origin?: string;
  /** Era keys the type belongs to (grouping, postwar, br1960); empty or absent = any era. */
  eras?: string[];
  /** A diagram number within its company's own numbering (e.g. D1730). */
  diagram?: string;
  /** The over-buffers length as the source gives it, e.g. "60 ft 8 in" (built-in types). */
  quoted?: string;
  /** Where the data came from. */
  source?: string;
  notes?: string;
  /** Shipped with the app (read-only: can be hidden, or copied to edit). */
  builtIn: boolean;
  /** For a copy of a built-in type: the type it was copied from. */
  copiedFrom?: string;
}

/** One vehicle in a layout's fleet (or minted for a train in play mode). */
export interface Vehicle {
  /** A GUID that never changes: what rakes, standing stock and shunts refer to. */
  id: string;
  /** Display identity, free text ("PO Wagon - Birley Colliery 542"); absent = the system identity is shown. */
  identity?: string;
  classId: string;
  /** Loaded (wagons and vans); absent = empty. */
  loaded?: boolean;
  /** What it is loaded with, optional. */
  load?: string;
  /** Home place (D17): stored now, used later to send empties back. */
  home?: string;
  /** This vehicle's own length over buffers, where it differs from its type. */
  metresOverBuffers?: number;
  /** This vehicle's own brake, where it differs from its type. */
  fitted?: boolean;
  /** Origin tag where it differs from its type (e.g. an inherited LNWR coach). */
  origin?: string;
  notes?: string;
}

/** Which end of a rake: A is the first vehicle in its list, B the last. */
export type RakeEnd = 'A' | 'B';

/** A rake: an ordered list of vehicles with two stable ends. */
export interface Rake {
  id: string;
  /** Its name (identity doubles as the label). */
  identity: string;
  /** Vehicle ids in order, end A first. A vehicle may be in several saved rakes (D20). */
  vehicleIds: string[];
  /** In the builder, the end an engine is assumed to be coupled to (D7; default A). */
  engineEnd: RakeEnd;
  notes: string;
}

/** A slot in a rake type: a class (or one of several), or the company goods mix, with a count range. */
export interface RakeSlot {
  classIds: string[];
  min: number;
  max: number;
  fitted?: boolean;
  loaded?: boolean;
  /** The group (portion) this slot belongs to. */
  group?: string;
  /** Reserved for day and season variations (D11): not used yet. */
  condition?: string;
  /**
   * Filled from the company's goods mix (v0.3.41, D9): wagons and vans drawn by the mix's weights, the
   * class ids then being only a fallback. A placeholder until goods train make-up is researched.
   */
  mix?: boolean;
}

/** A portion of a rake type, going to a kind of place (or staying with the train). */
export interface RakeGroup {
  id: string;
  name: string;
  destination: string;
}

/** A recipe rakes are made from (v0.3.41): built in, or a layout's own (RollingStock.rakeTypes). */
export interface RakeType {
  id: string;
  name: string;
  trainTypeIds: string[];
  duties?: string[];
  weight: number;
  origin?: string;
  eras?: string[];
  slots: RakeSlot[];
  groups?: RakeGroup[];
  /** A block train (one kind of wagon): weighted by the company's block-train weight for the era (v0.3.41, D9). */
  block?: boolean;
  /** Shipped with the app (read-only: hide or copy it to edit). */
  builtIn?: boolean;
  notes?: string;
}

/** A layout's rolling stock: its own library types, hidden built-ins, fleet and saved rakes. */
export interface RollingStock {
  /** Types the user added (or copied from built-ins). */
  classes: VehicleClass[];
  /** Built-in types hidden from the library lists. */
  hidden: string[];
  fleet: Vehicle[];
  rakes: Rake[];
  /** Rake types the user made (v0.3.41), and built-in rake types hidden from lists and the generator. */
  rakeTypes?: RakeType[];
  hiddenRakeTypes?: string[];
}

/**
 * Stock standing on its own in a road in play mode (an engine left it, or ran round it): its own
 * vehicles, in order. Minted vehicles live here while on the layout (D1), and are discarded with the
 * train that takes them off it (D1a).
 */
export interface StandingRake {
  id: string;
  vehicles: Vehicle[];
  placeId: string;
  roadId: string;
  /** The track circuit the road is on ('' when the road is not tied to one). */
  circuitId: string;
}
