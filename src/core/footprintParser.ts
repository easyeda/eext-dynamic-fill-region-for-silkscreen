/**
 * Footprint file parser for elibz2 format
 */

import JSZip from 'jszip';

const TAG = '[DynamicFill:FootprintParser]';

/**
 * Parse elibz2 footprint file (ZIP format containing .elibu JSON)
 * Returns the raw elibu content as text
 */
export async function parseFootprintFile(file: File): Promise<string | null> {
	if (!file) {
		console.warn(TAG, 'No file provided');
		return null;
	}

	try {
		const zip = await JSZip.loadAsync(file);

		// Find the .elibu file
		let elibuFile = null;
		for (const fileName in zip.files) {
			const fileEntry = zip.files[fileName];
			if (!fileEntry.dir && fileName.endsWith('.elibu')) {
				elibuFile = fileEntry;
				console.warn(TAG, `Found elibu file: ${fileName}`);
				break;
			}
		}

		if (!elibuFile) {
			console.warn(TAG, 'No .elibu file found in archive');
			return null;
		}

		// Read the elibu content as text
		const content = await elibuFile.async('text');
		return content;
	}
	catch (err) {
		console.error(TAG, 'Failed to parse footprint file:', err);
		return null;
	}
}

/**
 * Parse a single line of elibu format
 * Format: {"type":"TYPE","ticket":N,"id":"ID"}||{...geometry data...}
 */
function parseElibuLine(line: string): { type: string; data: any } | null {
	if (!line || line.trim().length === 0)
		return null;

	try {
		const parts = line.split('||');
		if (parts.length < 2)
			return null;

		const header = JSON.parse(parts[0]);
		const data = JSON.parse(parts[1]);

		return {
			type: header.type || '',
			data,
		};
	}
	catch (e) {
		return null;
	}
}

export interface FootprintPrimitive {
	type: string;
	layerId: number;
	data: any;
}

/**
 * Parse elibu content and extract all primitives
 */
export function parseElibuContent(content: string): FootprintPrimitive[] {
	const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
	const primitives: FootprintPrimitive[] = [];

	for (const line of lines) {
		const parsed = parseElibuLine(line);
		if (!parsed)
			continue;

		const layerId = parsed.data.layerId ?? parsed.data.layer ?? 0;

		primitives.push({
			type: parsed.type,
			layerId,
			data: parsed.data,
		});

		// Debug: log first few primitives
		if (primitives.length <= 3) {
			console.warn(TAG, `Primitive ${primitives.length}: type=${parsed.type}, layerId=${layerId}, data keys:`, Object.keys(parsed.data));
		}
	}

	console.warn(TAG, `Parsed ${primitives.length} primitives from elibu content`);
	return primitives;
}
