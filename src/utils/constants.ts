/**
 * Constants for the dynamic fill region extension
 */

// Layer IDs
export const LAYER_BOARD_OUTLINE = 11;
export const LAYER_TOP_SILKSCREEN = 3;
export const LAYER_BOTTOM_SILKSCREEN = 4;
export const LAYER_TOP_COPPER = 1;
export const LAYER_BOTTOM_COPPER = 2;
export const LAYER_SILKSCREEN_IN_FOOTPRINT = 3;

// Unit conversion
export const MIL_TO_MM = 0.0254;
export const MM_TO_MIL = 39.3701;

// Default values
export const DEFAULT_GAP_MILS = 10;
export const DEFAULT_TEXT_WIDTH_RATIO = 0.6; // Approximate character width ratio

// Polygon winding order
export enum WindingOrder {
	CLOCKWISE = 'CW',
	COUNTER_CLOCKWISE = 'CCW',
	UNKNOWN = 'UNKNOWN',
}
