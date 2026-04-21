/**
 * Gap input dialog
 */

import { DEFAULT_GAP_MILS } from '../utils/constants';

/**
 * Show dialog to get gap value from user
 * @returns Gap value in mils, or null if cancelled
 */
export async function showGapDialog(): Promise<number | null> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showInputDialog(
			'请输入布尔间隙（单位：mil）：',
			'间隙值用于在丝印图元、位号和焊盘周围创建安全距离',
			'动态丝印填充',
			'number',
			String(DEFAULT_GAP_MILS),
			{
				placeholder: '输入间隙值（mil）',
				min: 0,
				max: 1000,
			},
			(value: string | null) => {
				if (value === null || value === undefined) {
					resolve(null);
					return;
				}

				const gap = Number.parseFloat(value);
				if (isNaN(gap) || gap < 0) {
					eda.sys_Dialog.showInformationMessage(
						'无效的间隙值，请输入大于等于0的数字',
						'错误',
					);
					resolve(null);
					return;
				}

				resolve(gap);
			},
		);
	});
}
