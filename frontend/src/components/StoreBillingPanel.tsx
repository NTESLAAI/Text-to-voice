import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { loadStoreProducts, manageStoreSubscriptions, purchase, restore } from '../services/storeBilling';
import type { Product } from '@capgo/native-purchases';
export default function StoreBillingPanel() {
  const { t } = useTranslation();
  const [products, setProducts] = useState<Product[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    loadStoreProducts().then(result => { if (active) { setProducts(result.products); setEnabled(result.catalog.purchaseEnabled); } }).catch(() => { if (active) setMessage(t('mobile.failed')); });
    return () => { active = false; };
  }, [t]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true); setMessage('');
    try { await work(); setMessage(t('mobile.verified')); }
    catch { setMessage(t('mobile.failed')); }
    finally { setBusy(false); }
  }
  return <section aria-label={t('mobile.billing')}>
    <h2>{t('mobile.billing')}</h2>
    {!enabled && <p>{t('mobile.policyPending')}</p>}
    {!products.length && <p>{t('mobile.notConfigured')}</p>}
    {products.filter(p => Boolean(p.priceString)).map(p => <div key={`${p.planIdentifier ?? ''}:${p.identifier}:${p.offerToken ?? ''}`}>
      <span>{p.title} · {p.priceString}</span>{' '}
      <button type="button" disabled={!enabled || busy} onClick={() => void action(() => purchase(p))}>{t('mobile.buy')}</button>
    </div>)}
    <button type="button" disabled={busy} onClick={() => void action(restore)}>{t('mobile.restore')}</button>{' '}
    <button type="button" disabled={busy} onClick={() => void action(manageStoreSubscriptions)}>{t('mobile.manage')}</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
