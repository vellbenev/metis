import { useEffect, useState } from 'react';
import { createOpenAIProvider } from '../provider/openai';
import { testModel, type TestModelReport } from '../provider/testModel';
import type { Enrichment, ProfileName, Provider, ProviderProfile, ProviderSettings } from '../provider/types';
import { Bidi } from './bidi';
import type { SettingsStore } from './store';

export interface SettingsScreenProps {
	store: SettingsStore;
	/** Injected in tests; defaults to the OpenAI-compatible client. */
	createProvider?: (profile: ProviderProfile) => Provider;
}

const profileLabels: Record<ProfileName, string> = { clean: 'پاک‌نویس (Clean)', textbook: 'جزوه (Textbook)' };

const enrichmentLabels: Record<Enrichment, string> = {
	off: 'خاموش (off)',
	'flag-gaps': 'فقط علامت‌گذاری جاهای خالی (flag-gaps)',
	'light-add': 'تکمیل جمله‌های ناقص (light-add)',
};

type TestState = { running: true } | { running: false; report: TestModelReport };

export function SettingsScreen({ store, createProvider = createOpenAIProvider }: SettingsScreenProps) {
	const [settings, setSettings] = useState<ProviderSettings | null>(null);
	const [saved, setSaved] = useState(false);
	const [tests, setTests] = useState<Partial<Record<ProfileName, TestState>>>({});

	useEffect(() => {
		let live = true;
		store.load().then(s => live && setSettings(s));
		return () => {
			live = false;
		};
	}, [store]);

	if (!settings) return <section className='settings'>…</section>;

	const update = (next: ProviderSettings) => {
		setSettings(next);
		setSaved(false);
	};
	const updateProfile = (name: ProfileName, patch: Partial<ProviderProfile>) =>
		update({ ...settings, [name]: { ...settings[name], ...patch } });

	const save = async () => {
		await store.save(settings);
		setSaved(true);
	};

	// Runs only from the button's click handler: AI never runs automatically.
	const runTest = async (name: ProfileName) => {
		setTests(t => ({ ...t, [name]: { running: true } }));
		const report = await testModel(createProvider(settings[name]));
		setTests(t => ({ ...t, [name]: { running: false, report } }));
	};

	return (
		<section className='settings' aria-label='تنظیمات model'>
			{(['clean', 'textbook'] as const).map(name => {
				const profile = settings[name];
				const test = tests[name];
				return (
					<fieldset key={name} className='settings-profile' data-profile={name}>
						<legend>{profileLabels[name]}</legend>
						<label>
							baseUrl
							<input
								dir='ltr'
								name={`${name}-baseUrl`}
								value={profile.baseUrl}
								onChange={e => updateProfile(name, { baseUrl: e.target.value })}
							/>
						</label>
						<label>
							model
							<input
								dir='ltr'
								name={`${name}-model`}
								value={profile.model}
								onChange={e => updateProfile(name, { model: e.target.value })}
							/>
						</label>
						<label>
							API key
							<input
								dir='ltr'
								type='password'
								autoComplete='off'
								name={`${name}-apiKey`}
								value={profile.apiKey ?? ''}
								onChange={e => updateProfile(name, { apiKey: e.target.value || undefined })}
							/>
						</label>
						<button
							type='button'
							name={`${name}-test`}
							disabled={test?.running || !profile.baseUrl.trim() || !profile.model.trim()}
							onClick={() => runTest(name)}
						>
							Test model
						</button>
						{test && <TestResult state={test} />}
					</fieldset>
				);
			})}
			<label>
				افزودن محتوا توسط model
				<select
					name='enrichment'
					value={settings.enrichment}
					onChange={e => update({ ...settings, enrichment: e.target.value as Enrichment })}
				>
					{(Object.keys(enrichmentLabels) as Enrichment[]).map(e => (
						<option key={e} value={e}>
							{enrichmentLabels[e]}
						</option>
					))}
				</select>
			</label>
			<p className='settings-note'>تنظیمات و کلیدها فقط در همین مرورگر ذخیره می‌شوند، نه در vault.</p>
			<button type='button' name='save' onClick={save}>
				ذخیره
			</button>
			{saved && <span role='status'>ذخیره شد</span>}
		</section>
	);
}

function TestResult({ state }: { state: TestState }) {
	if (state.running) return <p role='status'>در حال آزمایش…</p>;
	const { report } = state;
	if (report.error) {
		return (
			<p role='alert' className='settings-error' data-kind={report.error.kind}>
				<Bidi text={report.error.message} />
			</p>
		);
	}
	const yesNo = (ok: boolean) => (ok ? 'بله' : 'خیر');
	return (
		<ul role='status' className='settings-report' data-ok={report.ok}>
			<li>پاسخ خالی نیست: {yesNo(report.nonEmpty)}</li>
			<li>
				<Bidi text={`اصطلاحات Latin حفظ شد: ${yesNo(report.missingLatinTerms.length === 0)}`} />
				{report.missingLatinTerms.length > 0 && <bdi dir='ltr'> ({report.missingLatinTerms.join(', ')})</bdi>}
			</li>
			{report.json !== 'not-requested' && (
				<li>
					<Bidi text={`JSON معتبر: ${yesNo(report.json === 'valid')}`} />
				</li>
			)}
			<li>
				زمان پاسخ: <bdi dir='ltr'>{Math.round(report.latencyMs)} ms</bdi>
			</li>
		</ul>
	);
}
