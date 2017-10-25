/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TPromise } from 'vs/base/common/winjs.base';
import { IExtensionRecommendationService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { IRequestService } from 'vs/platform/request/node/request';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { asJson } from 'vs/base/node/request';
import product from 'vs/platform/node/product';

export class ExtensionRecommendationService implements IExtensionRecommendationService {

	_serviceBrand: any;

	private recommendationServiceUrl: string;

	constructor(
		@IRequestService private requestService: IRequestService,
		@ITelemetryService private telemetryService: ITelemetryService
	) {
		this.recommendationServiceUrl = product.extensionRecommendationServiceUrl;
	}

	private api(path = ''): string {
		return `${this.recommendationServiceUrl}${path}`;
	}

	isEnabled(): boolean {
		return !!this.recommendationServiceUrl;
	}

	queryRelatedExtensions(extensionId: string): TPromise<string[]> {
		if (!this.isEnabled()) {
			return TPromise.wrapError<string[]>(new Error('No recommendation service configured.'));
		}

		/* __GDPR__
			"recommendationService:query" : {
				"type" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"text": { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this.telemetryService.publicLog('recommendationService:query', { type: 'relatedExtensions', extensionId });

		return this.queryService(`/related/${extensionId}`);
	}

	private async queryService(path: string, data?: JSON): TPromise<string[]> {
		if (!path) {
			return [];
		}

		const headers = {
			'Content-Type': 'application/json',
			'Accept': 'application/json;api-version=3.0-preview.1',
			'Accept-Encoding': 'gzip'
		};
		const url = this.api(path);
		const context = await this.requestService.request({
			type: 'GET',
			url,
			headers
		});

		if (context.res.statusCode >= 400 && context.res.statusCode < 500) {
			return [];
		}

		const result = await asJson<string[]>(context);
		return result;
	}
}