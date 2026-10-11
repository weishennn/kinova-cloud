'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Plane,
  MapPin,
  Calendar,
  Plus,
  Loader2,
  Compass,
  Eye,
  Edit2,
  Trash2,
  ChevronRight,
  Link2,
  Calculator,
  RefreshCw,
} from 'lucide-react';
import { useSheetData, useAddRow, useUpdateRow, useDeleteRow } from '@/hooks/useSheets';
import { useTransactions, Transaction } from '@/hooks/useTransactions';
import { useAppStore } from '@/stores/app-store';
import {
  COMMON_CURRENCIES,
  DEFAULT_EXCHANGE_RATES,
  convertCurrency,
  formatCurrency,
  getAmountInBaseCurrency,
  getCachedRatesToMyr,
} from '@/lib/currency';
import { getCategoryColor, getCategoryEmoji } from '@/lib/design-tokens';
import { getLocalDateString } from '@/lib/date-helper';
import { confirmAction } from '@/stores/confirm-dialog-store';
import { toast } from 'sonner';
import { AnimatedNumber } from '@/components/shared/animated-number';
import { CockpitPageHeading } from '@/components/money-cockpit/cockpit-page-heading';
import { CockpitModal, CockpitModalHeader } from '@/components/money-cockpit/cockpit-modal';
import { MoneyCalculator } from '@/components/shared/money-calculator';
import { SplitwiseTripPanel } from '@/components/trips/splitwise-trip-panel';
import {
  fetchSplitwiseTripSnapshot,
  formatSplitwiseCategory,
  getCachedSplitwiseSnapshot,
  getSavedSplitwiseConnection,
  resolveSplitwiseSummaryInCurrency,
  saveSplitwiseConnection,
  type SplitwiseTripMember,
} from '@/lib/splitwise';

type ExchangeBatch = {
  myr: string;
  foreign: string;
  label?: string;
};

type Trip = {
  id: string;
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
  budget: number;
  currency: string;
  status: string;
  rateToMyr: number;
  fxBatches?: ExchangeBatch[];
  rowIndex?: number;
};

function readRate(notes: unknown, currency: string): number {
  const match = String(notes || '').match(/rateToMyr\s*[=:]\s*([0-9.]+)/i);
  if (match?.[1]) {
    const parsed = parseFloat(match[1]);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return currency === 'MYR' ? 1 : 1 / (DEFAULT_EXCHANGE_RATES[currency] || 1);
}

function readFxBatches(notes: unknown): ExchangeBatch[] | undefined {
  const raw = String(notes || '');
  const match = raw.match(/fxBatches=([^\s|]+)/i);
  if (!match?.[1]) return undefined;
  try {
    const parsed = JSON.parse(decodeURIComponent(match[1]));
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((b: any, i: number) => ({
        myr: String(b?.myr ?? ''),
        foreign: String(b?.foreign ?? ''),
        label: String(b?.label || `Day ${i + 1}`),
      }));
    }
  } catch {
    // ignore malformed batches
  }
  return undefined;
}

function amountInTripCurrency(transaction: Transaction, trip: Trip): number {
  const txCurrency = (transaction.currency || 'MYR').toUpperCase();
  const tripCurrency = (trip.currency || 'MYR').toUpperCase();
  const txAmount = transaction.amount;

  if (txCurrency === tripCurrency) {
    return txAmount;
  }

  const amountMyr = getAmountInBaseCurrency(txAmount, txCurrency, transaction.baseAmount);
  if (tripCurrency === 'MYR') return amountMyr;
  if (trip.rateToMyr > 0) return amountMyr / trip.rateToMyr;
  return convertCurrency(txAmount, txCurrency, tripCurrency, getCachedRatesToMyr());
}

function amountInTripBaseMyr(transaction: Transaction, trip: Trip): number {
  const txCurrency = (transaction.currency || 'MYR').toUpperCase();
  const tripCurrency = (trip.currency || 'MYR').toUpperCase();
  if (txCurrency === 'MYR') return transaction.amount;
  if (txCurrency === tripCurrency && trip.rateToMyr > 0) {
    return transaction.amount * trip.rateToMyr;
  }
  return getAmountInBaseCurrency(transaction.amount, txCurrency, transaction.baseAmount);
}

export default function TripsPage() {
  const { setQuickAddOpen, setEditTransaction, aiPrefill, setAiPrefill } = useAppStore();
  const [isTripModalOpen, setIsTripModalOpen] = useState(false);
  const [editingTrip, setEditingTrip] = useState<Trip | null>(null);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [splitwiseSyncTick, setSplitwiseSyncTick] = useState(0);

  // Quick Trixpense Sync Hub states
  const [quickInviteCode, setQuickInviteCode] = useState('');
  const [isSyncingAll, setIsSyncingAll] = useState(false);
  const [syncingTripId, setSyncingTripId] = useState<string | null>(null);

  // Form states
  const [tripName, setTripName] = useState('');
  const [destination, setDestination] = useState('');
  const [startDate, setStartDate] = useState(() => getLocalDateString());
  const [endDate, setEndDate] = useState('');
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('MYR');
  const [rateToMyr, setRateToMyr] = useState('1');
  const [myrToForeignInput, setMyrToForeignInput] = useState('1');
  const [fxBatches, setFxBatches] = useState<ExchangeBatch[]>([
    { myr: '100', foreign: '160', label: 'Day 1' },
    { myr: '100', foreign: '162', label: 'Day 2' },
  ]);
  const [showBatchCalc, setShowBatchCalc] = useState(false);

  // Optional Trixpense link inside Create/Edit modal
  const [modalInviteCode, setModalInviteCode] = useState('');
  const [modalMemberId, setModalMemberId] = useState('');
  const [modalMembers, setModalMembers] = useState<SplitwiseTripMember[]>([]);
  const [isFetchingModalSplitwise, setIsFetchingModalSplitwise] = useState(false);

  const bumpSplitwiseSync = useCallback(() => {
    setSplitwiseSyncTick(prev => prev + 1);
  }, []);

  const syncRateFromRateToMyr = (valStr: string) => {
    setRateToMyr(valStr);
    const num = parseFloat(valStr);
    if (num > 0) {
      setMyrToForeignInput(Number((1 / num).toFixed(4)).toString());
    }
  };

  const syncRateFromMyrToForeign = (valStr: string) => {
    setMyrToForeignInput(valStr);
    const num = parseFloat(valStr);
    if (num > 0) {
      setRateToMyr(Number((1 / num).toFixed(6)).toString());
    }
  };

  // Weighted average from multi-day exchange batches (e.g. Day 1: 100 MYR -> 160 CNY, Day 2: 100 MYR -> 162 CNY => 1 MYR = 1.61 CNY)
  const batchSummary = useMemo(() => {
    let totalMyr = 0;
    let totalForeign = 0;
    let validCount = 0;
    fxBatches.forEach(b => {
      const m = parseFloat(b.myr);
      const f = parseFloat(b.foreign);
      if (m > 0 && f > 0) {
        totalMyr += m;
        totalForeign += f;
        validCount += 1;
      }
    });
    const avgMyrToForeign = totalMyr > 0 && totalForeign > 0 ? totalForeign / totalMyr : 0;
    const avgForeignToMyr = avgMyrToForeign > 0 ? 1 / avgMyrToForeign : 0;
    return {
      totalMyr,
      totalForeign,
      validCount,
      avgMyrToForeign,
      avgForeignToMyr,
    };
  }, [fxBatches]);

  const applyBatchAverageRate = () => {
    if (batchSummary.avgForeignToMyr <= 0) {
      toast.error('Enter valid MYR and foreign amounts in at least one row');
      return;
    }
    setMyrToForeignInput(Number(batchSummary.avgMyrToForeign.toFixed(4)).toString());
    setRateToMyr(Number(batchSummary.avgForeignToMyr.toFixed(6)).toString());
    toast.success(
      `Applied average rate: 1 MYR = ${batchSummary.avgMyrToForeign.toFixed(4)} ${currency} (1 ${currency} = RM ${batchSummary.avgForeignToMyr.toFixed(4)})`,
    );
  };

  // AI trip drafts open the existing trip form; no write happens until submit.
  useEffect(() => {
    if (aiPrefill?.kind !== 'trip') return;
    const draft = aiPrefill.data;
    setEditingTrip(null);
    setTripName(draft.name);
    setDestination(draft.destination || draft.name);
    setStartDate(draft.startDate);
    setEndDate(draft.endDate || '');
    setBudget(draft.budget == null ? '' : String(draft.budget));
    setCurrency(draft.currency || 'MYR');
    const r = draft.rateToMyr == null ? '1' : String(draft.rateToMyr);
    syncRateFromRateToMyr(r);
    setModalInviteCode('');
    setModalMemberId('');
    setModalMembers([]);
    setIsTripModalOpen(true);
    setAiPrefill(null);
  }, [aiPrefill, setAiPrefill]);

  const { data: rawTripsData, isLoading: isTripsLoading } = useSheetData('Trips');
  const { transactions = [] } = useTransactions();
  const addTripMutation = useAddRow();
  const updateTripMutation = useUpdateRow();
  const deleteTripMutation = useDeleteRow();

  const trips = useMemo<Trip[]>(() => {
    return (rawTripsData?.rows || [])
      .map((r: any, idx: number) => {
        const name = String(
          r.TripName || r.tripName || r.Name || r.name || `Trip #${idx + 1}`,
        ).trim();
        const tripCurrency = String(r.Currency || r.currency || 'MYR')
          .trim()
          .toUpperCase();
        const id = String(r.Id || r.id || name).trim();
        const notesRaw = r.Notes || r.notes;
        const rate = readRate(notesRaw, tripCurrency);
        const batches = readFxBatches(notesRaw);
        return {
          id,
          name,
          destination: String(r.Destination || r.destination || 'Vacation'),
          startDate: String(r.StartDate || r.startDate || r.start_date || ''),
          endDate: String(r.EndDate || r.endDate || r.end_date || ''),
          budget: Number(r.Budget || r.budget || 0) || 0,
          currency: tripCurrency,
          status: String(r.Status || r.status || 'Active'),
          rateToMyr: rate,
          fxBatches: batches,
          rowIndex: typeof r._rowIndex === 'number' ? r._rowIndex : idx + 2,
        };
      })
      .filter(t => t.name);
  }, [rawTripsData]);

  // Background refresh any linked Trixpense snapshots when trips load
  useEffect(() => {
    if (!trips.length) return;
    let active = true;
    trips.forEach(trip => {
      const conn = getSavedSplitwiseConnection(trip.id);
      if (!conn?.inviteCode) return;
      void fetchSplitwiseTripSnapshot(conn.inviteCode)
        .then(() => {
          if (active) setSplitwiseSyncTick(prev => prev + 1);
        })
        .catch(() => {
          // Ignore background refresh errors; cached snapshot is still used
        });
    });
    return () => {
      active = false;
    };
  }, [trips]);

  const spendMap = useMemo(() => {
    void splitwiseSyncTick;
    const map: Record<
      string,
      {
        personalTotal: number;
        personalTotalMyr: number;
        splitwiseShare: number;
        splitwiseShareMyr: number;
        splitwiseInviteCode: string | null;
        splitwiseIncluded: boolean;
        total: number;
        totalMyr: number;
        transactions: Transaction[];
        unifiedCategories: Array<{
          name: string;
          personalAmount: number;
          trixpenseAmount: number;
          totalAmount: number;
          totalMyr: number;
        }>;
      }
    > = {};

    trips.forEach(trip => {
      // Exclude virtual `trixpense_` rows from `matched` here because Trixpense is summed via `splitwiseShare` below
      const matched = transactions.filter(tx => {
        if (tx.type !== 'expense') return false;
        if (String(tx.id || '').startsWith('trixpense_')) return false;
        const tag = (tx.tripTag || tx.tripId || '').trim();
        return tag === trip.name || tag === trip.id;
      });
      const personalTotal = matched.reduce((sum, tx) => sum + amountInTripCurrency(tx, trip), 0);
      const personalTotalMyr = matched.reduce((sum, tx) => sum + amountInTripBaseMyr(tx, trip), 0);

      // Build unified category map (synced between Kinova personal trip expenses and Trixpense shared expenses)
      const catBuckets = new Map<
        string,
        { personalAmount: number; trixpenseAmount: number; personalMyr: number; trixpenseMyr: number }
      >();

      matched.forEach(tx => {
        const catName = formatSplitwiseCategory(tx.category || 'Other');
        const amtTrip = amountInTripCurrency(tx, trip);
        const amtMyr = amountInTripBaseMyr(tx, trip);
        const cur = catBuckets.get(catName) || {
          personalAmount: 0,
          trixpenseAmount: 0,
          personalMyr: 0,
          trixpenseMyr: 0,
        };
        cur.personalAmount += amtTrip;
        cur.personalMyr += amtMyr;
        catBuckets.set(catName, cur);
      });

      let splitwiseShare = 0;
      let splitwiseShareMyr = 0;
      let splitwiseInviteCode: string | null = null;
      let splitwiseIncluded = false;

      const conn =
        getSavedSplitwiseConnection(trip.id) ||
        (trip.name !== trip.id ? getSavedSplitwiseConnection(trip.name) : null);
      if (conn?.inviteCode) {
        splitwiseInviteCode = conn.inviteCode;
        const snap = getCachedSplitwiseSnapshot(conn.inviteCode);
        const effectiveMemberId =
          snap?.members.find(m => m.id === conn.memberId)?.id ||
          snap?.members.find(m => /wei\s*shen/i.test(m.display_name))?.id ||
          snap?.members[0]?.id ||
          '';
        if (snap && effectiveMemberId) {
          try {
            // Native-currency aware resolution: MYR expenses stay exact in MYR, foreign expenses stay exact
            const resolvedTrip = resolveSplitwiseSummaryInCurrency(
              snap,
              effectiveMemberId,
              trip.currency,
              trip.currency,
              trip.rateToMyr,
            );
            const resolvedMyr = resolveSplitwiseSummaryInCurrency(
              snap,
              effectiveMemberId,
              'MYR',
              trip.currency,
              trip.rateToMyr,
            );
            splitwiseShare = resolvedTrip.memberShare;
            splitwiseShareMyr = resolvedMyr.memberShare;
            splitwiseIncluded = conn.includeInBudget !== false;

            if (splitwiseIncluded) {
              const myrByCat = new Map(resolvedMyr.categories.map(c => [c.name, c.amount]));
              resolvedTrip.categories.forEach(c => {
                const cur = catBuckets.get(c.name) || {
                  personalAmount: 0,
                  trixpenseAmount: 0,
                  personalMyr: 0,
                  trixpenseMyr: 0,
                };
                cur.trixpenseAmount += c.amount;
                cur.trixpenseMyr += myrByCat.get(c.name) || 0;
                catBuckets.set(c.name, cur);
              });
            }
          } catch {
            // ignore summary error
          }
        }
      }

      const total = personalTotal + (splitwiseIncluded ? splitwiseShare : 0);
      const totalMyr = personalTotalMyr + (splitwiseIncluded ? splitwiseShareMyr : 0);

      const unifiedCategories = [...catBuckets.entries()]
        .map(([name, b]) => ({
          name,
          personalAmount: b.personalAmount,
          trixpenseAmount: b.trixpenseAmount,
          totalAmount: b.personalAmount + b.trixpenseAmount,
          totalMyr: b.personalMyr + b.trixpenseMyr,
        }))
        .filter(c => c.totalAmount > 0.005)
        .sort((a, b) => b.totalAmount - a.totalAmount);

      map[trip.id] = {
        personalTotal,
        personalTotalMyr,
        splitwiseShare,
        splitwiseShareMyr,
        splitwiseInviteCode,
        splitwiseIncluded,
        total,
        totalMyr,
        transactions: matched,
        unifiedCategories,
      };
    });
    return map;
  }, [transactions, trips, splitwiseSyncTick]);

  const applyCurrencyDefaultRate = (c: string) => {
    const code = String(c || 'MYR').toUpperCase();
    setCurrency(code);
    if (code === 'MYR') {
      syncRateFromRateToMyr('1');
      return;
    }
    const defaultRatesToMyr: Record<string, string> = {
      AUD: '2.85',
      CNY: '0.6211',
      USD: '4.30',
      SGD: '3.25',
      JPY: '0.029',
      THB: '0.128',
      EUR: '4.75',
      GBP: '5.55',
      HKD: '0.55',
      TWD: '0.135',
      KRW: '0.0032',
      IDR: '0.00028',
      NZD: '2.60',
      CAD: '3.15',
      CHF: '4.95',
    };
    if (defaultRatesToMyr[code]) {
      syncRateFromRateToMyr(defaultRatesToMyr[code]);
    } else if (DEFAULT_EXCHANGE_RATES[code] && DEFAULT_EXCHANGE_RATES[code] > 0) {
      syncRateFromMyrToForeign(String(DEFAULT_EXCHANGE_RATES[code]));
    } else {
      syncRateFromRateToMyr('1');
    }
  };

  const openCreate = () => {
    setEditingTrip(null);
    setTripName('');
    setDestination('');
    setStartDate(getLocalDateString());
    setEndDate('');
    setBudget('');
    setCurrency('MYR');
    syncRateFromRateToMyr('1');
    setFxBatches([
      { myr: '100', foreign: '160', label: 'Day 1' },
      { myr: '100', foreign: '162', label: 'Day 2' },
    ]);
    setShowBatchCalc(false);
    setModalInviteCode('');
    setModalMemberId('');
    setModalMembers([]);
    setIsTripModalOpen(true);
  };

  const openEdit = (trip: Trip) => {
    setEditingTrip(trip);
    setTripName(trip.name);
    setDestination(trip.destination);
    setStartDate(trip.startDate);
    setEndDate(trip.endDate);
    setBudget(String(trip.budget || ''));
    setCurrency(trip.currency);
    syncRateFromRateToMyr(String(trip.rateToMyr || '1'));
    if (trip.fxBatches && trip.fxBatches.length > 0) {
      setFxBatches(trip.fxBatches);
      setShowBatchCalc(true);
    } else {
      setFxBatches([
        { myr: '100', foreign: '160', label: 'Day 1' },
        { myr: '100', foreign: '162', label: 'Day 2' },
      ]);
      setShowBatchCalc(false);
    }
    const existingConn = getSavedSplitwiseConnection(trip.id);
    if (existingConn) {
      setModalInviteCode(existingConn.inviteCode);
      setModalMemberId(existingConn.memberId);
      const cached = getCachedSplitwiseSnapshot(existingConn.inviteCode);
      setModalMembers(cached?.members || []);
    } else {
      setModalInviteCode('');
      setModalMemberId('');
      setModalMembers([]);
    }
    setIsTripModalOpen(true);
  };

  const handleModalFetchSplitwise = async () => {
    const code = modalInviteCode.trim().toUpperCase();
    if (code.length !== 8) {
      toast.error('Enter an 8-character Trixpense invite code first');
      return;
    }
    setIsFetchingModalSplitwise(true);
    try {
      const snap = await fetchSplitwiseTripSnapshot(code);
      setModalMembers(snap.members);

      if (snap.trip.name && (!editingTrip || !tripName.trim())) {
        setTripName(snap.trip.name);
      }
      if (snap.trip.name && (!editingTrip || !destination.trim())) {
        setDestination(snap.trip.name);
      }

      const activeExpenses = snap.expenses.filter(
        e => !e.is_settlement && e.category !== '__deleted__',
      );

      // Determine trip currency (prefer foreign currency if base_currency is MYR but expenses use AUD/CNY/etc.)
      const baseCurr = String(snap.trip.base_currency || 'MYR').toUpperCase();
      const expForeignCurr = activeExpenses
        .map(e => String(e.currency || '').toUpperCase())
        .find(c => c && c !== 'MYR');
      const targetCurr = baseCurr !== 'MYR' ? baseCurr : expForeignCurr || 'MYR';

      if (!editingTrip || currency === 'MYR') {
        applyCurrencyDefaultRate(targetCurr);

        // If Trixpense expenses already carry a real exchange rate between MYR and targetCurr, auto-fill it!
        if (targetCurr !== 'MYR') {
          if (baseCurr === 'MYR') {
            const expWithRate = activeExpenses.find(
              e => String(e.currency || '').toUpperCase() === targetCurr && Number(e.fx_rate) > 0,
            );
            if (expWithRate?.fx_rate) {
              syncRateFromRateToMyr(Number(expWithRate.fx_rate).toFixed(6));
            }
          } else if (baseCurr === targetCurr) {
            const myrExpWithRate = activeExpenses.find(
              e => String(e.currency || '').toUpperCase() === 'MYR' && Number(e.fx_rate) > 0,
            );
            if (myrExpWithRate?.fx_rate) {
              syncRateFromMyrToForeign(Number(myrExpWithRate.fx_rate).toFixed(4));
            }
          }
        }
      }

      // Auto-fill start date and end date from Trixpense expense dates
      const validDates = activeExpenses
        .map(e => String(e.expense_date || '').trim())
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
      if (validDates.length > 0 && !editingTrip) {
        setStartDate(validDates[0]);
        setEndDate(validDates[validDates.length - 1]);
      }

      // Auto-select member so the link works immediately even with multiple members
      const validMemberStillSelected = snap.members.some(m => m.id === modalMemberId);
      const preferredMember =
        snap.members.find(m => /wei\s*shen/i.test(m.display_name)) || snap.members[0];
      const chosenMemberId = validMemberStillSelected
        ? modalMemberId
        : preferredMember?.id || '';
      if (chosenMemberId) {
        setModalMemberId(chosenMemberId);
      }

      toast.success(
        `Auto-filled "${snap.trip.name}" (${targetCurr} · ${snap.members.length} members · ${activeExpenses.length} bills)!`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not fetch Trixpense trip');
    } finally {
      setIsFetchingModalSplitwise(false);
    }
  };

  const syncSingleTrip = async (trip: Trip) => {
    const conn =
      getSavedSplitwiseConnection(trip.id) ||
      (trip.name !== trip.id ? getSavedSplitwiseConnection(trip.name) : null);
    if (!conn?.inviteCode) {
      openEdit(trip);
      return;
    }
    setSyncingTripId(trip.id);
    try {
      const snap = await fetchSplitwiseTripSnapshot(conn.inviteCode);
      const validMember =
        snap.members.find(m => m.id === conn.memberId) ||
        snap.members.find(m => /wei\s*shen/i.test(m.display_name)) ||
        snap.members[0];
      saveSplitwiseConnection(trip.id, {
        inviteCode: conn.inviteCode,
        memberId: validMember?.id || conn.memberId || '',
        includeInBudget: conn.includeInBudget !== false,
      });
      bumpSplitwiseSync();
      const activeCount = snap.expenses.filter(
        e => !e.is_settlement && e.category !== '__deleted__',
      ).length;
      toast.success(
        `Synced "${trip.name}" with Trixpense (${conn.inviteCode} · ${activeCount} bills)! Flow & Overview updated.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Could not sync "${trip.name}" with Trixpense`,
      );
    } finally {
      setSyncingTripId(null);
    }
  };

  const syncAllLinkedTrips = async () => {
    const linked = trips
      .map(t => ({
        trip: t,
        conn:
          getSavedSplitwiseConnection(t.id) ||
          (t.name !== t.id ? getSavedSplitwiseConnection(t.name) : null),
      }))
      .filter(item => Boolean(item.conn?.inviteCode));

    if (linked.length === 0) {
      toast.info('No linked Trixpense trips yet — enter an 8-character invite code to link one!');
      return;
    }

    setIsSyncingAll(true);
    try {
      let syncedCount = 0;
      for (const { trip, conn } of linked) {
        if (!conn?.inviteCode) continue;
        const snap = await fetchSplitwiseTripSnapshot(conn.inviteCode);
        const validMember =
          snap.members.find(m => m.id === conn.memberId) ||
          snap.members.find(m => /wei\s*shen/i.test(m.display_name)) ||
          snap.members[0];
        saveSplitwiseConnection(trip.id, {
          inviteCode: conn.inviteCode,
          memberId: validMember?.id || conn.memberId || '',
          includeInBudget: conn.includeInBudget !== false,
        });
        syncedCount += 1;
      }
      bumpSplitwiseSync();
      toast.success(
        `Synced ${syncedCount} Trixpense trip${syncedCount === 1 ? '' : 's'}! Flow & Overview updated.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to sync Trixpense trips');
    } finally {
      setIsSyncingAll(false);
    }
  };

  const handleQuickCodeConnect = async (event: React.FormEvent) => {
    event.preventDefault();
    const code = quickInviteCode.trim().toUpperCase();
    if (code.length !== 8) {
      toast.error('Please enter an 8-character Trixpense invite code (e.g. A1B2C3D4)');
      return;
    }
    setIsSyncingAll(true);
    try {
      const snap = await fetchSplitwiseTripSnapshot(code);
      const preferredMember =
        snap.members.find(m => /wei\s*shen/i.test(m.display_name)) || snap.members[0];
      const memberId = preferredMember?.id || '';

      // Check if a trip already matches this invite code or trip name
      const matchingTrip = trips.find(t => {
        const existingConn =
          getSavedSplitwiseConnection(t.id) ||
          (t.name !== t.id ? getSavedSplitwiseConnection(t.name) : null);
        if (existingConn?.inviteCode === code) return true;
        return t.name.trim().toLowerCase() === String(snap.trip.name || '').trim().toLowerCase();
      });

      if (matchingTrip) {
        saveSplitwiseConnection(matchingTrip.id, {
          inviteCode: code,
          memberId,
          includeInBudget: true,
        });
        setQuickInviteCode('');
        bumpSplitwiseSync();
        toast.success(
          `Linked & synced "${matchingTrip.name}" with Trixpense (${code})! Added to Flow & Overview.`,
        );
        return;
      }

      // Otherwise open the Create Trip modal pre-filled from Trixpense!
      setEditingTrip(null);
      setTripName(snap.trip.name || 'Trixpense Trip');
      setDestination(snap.trip.name || 'Vacation');
      const activeExpenses = snap.expenses.filter(
        e => !e.is_settlement && e.category !== '__deleted__',
      );
      const baseCurr = String(snap.trip.base_currency || 'MYR').toUpperCase();
      const expForeignCurr = activeExpenses
        .map(e => String(e.currency || '').toUpperCase())
        .find(c => c && c !== 'MYR');
      const targetCurr = baseCurr !== 'MYR' ? baseCurr : expForeignCurr || 'MYR';
      applyCurrencyDefaultRate(targetCurr);

      const validDates = activeExpenses
        .map(e => String(e.expense_date || '').trim())
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
      setStartDate(validDates[0] || getLocalDateString());
      setEndDate(validDates[validDates.length - 1] || '');
      setBudget('5000');
      setModalInviteCode(code);
      setModalMembers(snap.members);
      setModalMemberId(memberId);
      setQuickInviteCode('');
      setIsTripModalOpen(true);
      toast.success(
        `Loaded "${snap.trip.name}" from Trixpense! Click "Create Trip" to save & sync to Flow.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not fetch Trixpense invite code');
    } finally {
      setIsSyncingAll(false);
    }
  };

  const saveTrip = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tripName.trim()) return toast.error('Please enter a trip name');

    const parsedBudget = parseFloat(budget) || 0;
    const parsedRate = parseFloat(rateToMyr) || 1;
    const tripId = editingTrip?.id || `trip_${Date.now()}`;

    const cleanBatches = fxBatches.filter(b => parseFloat(b.myr) > 0 && parseFloat(b.foreign) > 0);
    const notesParts = [`rateToMyr=${parsedRate}`];
    if (currency !== 'MYR' && cleanBatches.length > 0) {
      notesParts.push(`fxBatches=${encodeURIComponent(JSON.stringify(cleanBatches))}`);
    }

    const rowData = {
      Id: tripId,
      Name: tripName.trim(),
      Destination: destination.trim() || tripName.trim(),
      StartDate: startDate,
      EndDate: endDate || startDate,
      Budget: parsedBudget,
      Currency: currency,
      Status: 'Active',
      Notes: notesParts.join(' | '),
    };

    try {
      if (editingTrip) {
        await updateTripMutation.mutateAsync({
          sheetName: 'Trips',
          rowIndex: editingTrip.rowIndex || 2,
          rowData,
        });
        toast.success(`Trip "${tripName}" updated!`);
      } else {
        await addTripMutation.mutateAsync({
          sheetName: 'Trips',
          rowData,
        });
        toast.success(`Trip "${tripName}" created! 🎉`);
      }

      const cleanInvite = modalInviteCode.trim().toUpperCase();
      if (/^[A-Z0-9]{8}$/.test(cleanInvite)) {
        let finalMemberId = modalMemberId;
        if (!finalMemberId) {
          try {
            const snap = getCachedSplitwiseSnapshot(cleanInvite) || (await fetchSplitwiseTripSnapshot(cleanInvite));
            const preferred =
              snap?.members?.find(m => /wei\s*shen/i.test(m.display_name)) || snap?.members?.[0];
            finalMemberId = preferred?.id || '';
          } catch {
            // ignore
          }
        }
        saveSplitwiseConnection(tripId, {
          inviteCode: cleanInvite,
          memberId: finalMemberId,
          includeInBudget: true,
        });
        bumpSplitwiseSync();
      }

      setIsTripModalOpen(false);
    } catch (error) {
      console.error(error);
      toast.error(`Failed to ${editingTrip ? 'update' : 'create'} trip`);
    }
  };

  const deleteTrip = async (trip: Trip) => {
    const ok = await confirmAction({
      title: 'Delete Trip?',
      description: `Delete trip "${trip.name}"? Recorded expenses will remain in your records.`,
      confirmText: 'Delete Trip',
      cancelText: 'Keep Trip',
      variant: 'danger',
      icon: 'trash',
    });
    if (!ok) return;

    try {
      await deleteTripMutation.mutateAsync({
        sheetName: 'Trips',
        rowIndex: trip.rowIndex,
        id: trip.id,
      });
      if (selectedTripId === trip.id) setSelectedTripId(null);
      toast.success('Trip deleted');
    } catch (error) {
      console.error(error);
      toast.error('Failed to delete trip');
    }
  };

  const selectedTrip = trips.find(t => t.id === selectedTripId);
  const linkedTripsCount = trips.filter(t => Boolean(spendMap[t.id]?.splitwiseInviteCode)).length;

  return (
    <div className="cockpit-module-page">
      <CockpitPageHeading
        title="Trip & Travel Tracker"
        description="Track budgets in original currency (AUD, CNY, MYR, etc.) with live Trixpense group sync into Kinova Flow & Overview"
        action={
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={openCreate}
            className="cockpit-primary-action"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>New Trip</span>
          </motion.button>
        }
      />

      {/* Prominent Trixpense Live Sync Hub */}
      <div className="rounded-3xl border border-indigo-500/25 bg-gradient-to-r from-indigo-500/[0.08] via-purple-500/[0.06] to-emerald-500/[0.06] p-4 sm:p-5 shadow-lg backdrop-blur-xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/25">
              <Link2 className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm font-bold text-slate-950 dark:text-white">
                  Trixpense Live Sync
                </h2>
                <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/25">
                  {linkedTripsCount > 0
                    ? `${linkedTripsCount} Linked · Auto-Synced to Flow`
                    : 'Ready to Link'}
                </span>
              </div>
              <p className="text-xs text-slate-600 dark:text-zinc-300 mt-0.5">
                Link any 8-character Trixpense invite code to automatically sync your personal share
                into <strong>Flow</strong>, <strong>Overview</strong>, and <strong>Trip Budgets</strong>.
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <form onSubmit={handleQuickCodeConnect} className="flex items-center gap-2">
              <input
                type="text"
                value={quickInviteCode}
                onChange={e =>
                  setQuickInviteCode(
                    e.target.value
                      .replace(/[^a-z0-9]/gi, '')
                      .slice(0, 8)
                      .toUpperCase(),
                  )
                }
                maxLength={8}
                placeholder="Invite code (e.g. A1B2C3D4)"
                className="h-10 w-full sm:w-44 rounded-xl border border-slate-300 dark:border-white/10 bg-white/90 dark:bg-zinc-950/80 px-3 text-xs font-mono uppercase tracking-widest text-slate-950 dark:text-white outline-none focus:border-indigo-500"
              />
              <button
                type="submit"
                disabled={isSyncingAll || quickInviteCode.trim().length !== 8}
                className="h-10 shrink-0 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold transition-all cursor-pointer touch-manipulation"
              >
                Link / Import
              </button>
            </form>

            {linkedTripsCount > 0 && (
              <button
                type="button"
                onClick={() => void syncAllLinkedTrips()}
                disabled={isSyncingAll}
                className="h-10 shrink-0 inline-flex items-center justify-center gap-1.5 px-3.5 rounded-xl border border-emerald-500/30 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-900 dark:text-emerald-200 text-xs font-semibold transition-all cursor-pointer touch-manipulation disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isSyncingAll ? 'animate-spin' : ''}`} />
                <span>{isSyncingAll ? 'Syncing…' : 'Sync All with Trixpense'}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Trips Grid */}
      {isTripsLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-indigo-800 dark:text-indigo-400" />
        </div>
      ) : trips.length === 0 ? (
        <div className="py-16 text-center rounded-3xl border border-dashed border-slate-200 dark:border-white/[0.1] bg-card/40 backdrop-blur-xl p-8 shadow-lg">
          <motion.div
            animate={{ y: [0, -6, 0] }}
            transition={{ repeat: Infinity, duration: 3, ease: 'easeInOut' }}
          >
            <Compass className="h-10 w-10 text-indigo-800 dark:text-indigo-400 mx-auto mb-3 opacity-80" />
          </motion.div>
          <h3 className="text-base font-semibold text-slate-950 dark:text-white">
            No Trips Created Yet
          </h3>
          <p className="text-xs text-slate-600 dark:text-zinc-400 max-w-sm mx-auto mt-1 mb-5">
            Create a trip (e.g. Australia, Chengdu, Tokyo) or paste your Trixpense invite code
            above to import and sync your shared expenses automatically.
          </p>
          <button
            onClick={openCreate}
            className="min-h-[40px] px-5 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 active:scale-[0.97] text-white dark:text-white text-xs font-semibold shadow-md transition-all cursor-pointer touch-manipulation"
          >
            Create Your First Trip
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {trips.map(trip => {
            const info = spendMap[trip.id] || {
              personalTotal: 0,
              personalTotalMyr: 0,
              splitwiseShare: 0,
              splitwiseShareMyr: 0,
              splitwiseInviteCode: null,
              splitwiseIncluded: false,
              total: 0,
              totalMyr: 0,
              transactions: [],
              unifiedCategories: [],
            };
            const progress = trip.budget > 0 ? Math.min((info.total / trip.budget) * 100, 100) : 0;
            const over = trip.budget > 0 && info.total > trip.budget;
            const isForeign = trip.currency !== 'MYR';
            const inverseRate = trip.rateToMyr > 0 ? 1 / trip.rateToMyr : 0;
            const isThisSyncing = syncingTripId === trip.id;

            return (
              <motion.div
                key={trip.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                whileHover={{ y: -3, scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
                onClick={() => setSelectedTripId(trip.id)}
                className="relative rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 hover:bg-card/85 p-6 backdrop-blur-2xl hover:border-indigo-500/40 shadow-xl hover:shadow-2xl transition-all flex flex-col justify-between cursor-pointer group specular-card"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] font-bold font-mono px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30">
                          {trip.currency}
                        </span>
                        {isForeign && (
                          <span className="text-[11px] text-slate-700 dark:text-zinc-300 font-mono">
                            1 MYR ≈ {inverseRate.toFixed(4)} {trip.currency} (1 {trip.currency} ≈ RM{' '}
                            {trip.rateToMyr.toFixed(4)})
                          </span>
                        )}
                        {info.splitwiseInviteCode && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/25">
                            <Link2 className="h-2.5 w-2.5" />
                            Trixpense · {info.splitwiseInviteCode}
                          </span>
                        )}
                      </div>
                      <h2 className="text-xl font-bold text-slate-950 dark:text-white group-hover:text-indigo-800 dark:group-hover:text-indigo-300 transition-colors mt-1.5">
                        {trip.name}
                      </h2>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        title={
                          info.splitwiseInviteCode
                            ? `Sync "${trip.name}" with Trixpense (${info.splitwiseInviteCode})`
                            : 'Link Trixpense invite code'
                        }
                        onClick={e => {
                          e.stopPropagation();
                          void syncSingleTrip(trip);
                        }}
                        className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-xl border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 transition-all active:scale-95 cursor-pointer touch-manipulation"
                      >
                        <RefreshCw
                          className={`h-3.5 w-3.5 ${isThisSyncing ? 'animate-spin' : ''}`}
                        />
                        <span>{info.splitwiseInviteCode ? 'Sync' : 'Link Trixpense'}</span>
                      </button>
                      <button
                        title="View trip expense details"
                        onClick={e => {
                          e.stopPropagation();
                          setSelectedTripId(trip.id);
                        }}
                        className="min-w-[38px] min-h-[38px] flex items-center justify-center p-2 text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-white/[0.06] rounded-xl transition-all active:scale-95 cursor-pointer touch-manipulation"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                      <button
                        title="Edit trip"
                        onClick={e => {
                          e.stopPropagation();
                          openEdit(trip);
                        }}
                        className="min-w-[38px] min-h-[38px] flex items-center justify-center p-2 text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-white/[0.06] rounded-xl transition-all active:scale-95 cursor-pointer touch-manipulation"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        title="Delete trip"
                        onClick={e => {
                          e.stopPropagation();
                          void deleteTrip(trip);
                        }}
                        className="min-w-[38px] min-h-[38px] flex items-center justify-center p-2 text-slate-600 dark:text-zinc-400 hover:text-rose-800 dark:hover:text-rose-400 hover:bg-white/[0.06] rounded-xl transition-all active:scale-95 cursor-pointer touch-manipulation"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap gap-3 text-xs text-slate-700 dark:text-zinc-300">
                    <span className="flex items-center gap-1.5">
                      <MapPin className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
                      {trip.destination}
                    </span>
                    <span className="flex items-center gap-1.5 font-mono">
                      <Calendar className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
                      {trip.startDate} {trip.endDate && `→ ${trip.endDate}`}
                    </span>
                  </div>
                </div>

                <div className="mt-6 space-y-2.5">
                  <div className="flex justify-between items-baseline text-xs text-slate-600 dark:text-zinc-400">
                    <span>
                      Spent:{' '}
                      <strong className="text-slate-950 dark:text-white text-sm font-mono tabular-nums tracking-tight">
                        <AnimatedNumber
                          value={info.total}
                          prefix=""
                          formatValue={value => formatCurrency(value, trip.currency)}
                          animateOnMount
                        />
                      </strong>
                      {isForeign && info.totalMyr > 0 && (
                        <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-mono ml-1">
                          (≈ RM {info.totalMyr.toFixed(2)})
                        </span>
                      )}
                    </span>
                    <span>
                      Budget:{' '}
                      <strong className="text-slate-800 dark:text-zinc-200 font-mono tabular-nums tracking-tight">
                        <AnimatedNumber
                          value={trip.budget}
                          prefix=""
                          formatValue={value => formatCurrency(value, trip.currency)}
                          animateOnMount
                        />
                      </strong>
                    </span>
                  </div>

                  <div className="h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800/80">
                    <div
                      className={`h-full rounded-full transition-all ${
                        over ? 'bg-rose-500' : 'bg-gradient-to-r from-indigo-500 to-purple-500'
                      }`}
                      style={{ width: `${progress}%` }}
                    />
                  </div>

                  <div className="flex justify-between items-center text-[11px] text-slate-600 dark:text-zinc-400">
                    <span>
                      {info.transactions.length} tagged payment
                      {info.transactions.length === 1 ? '' : 's'}
                      {info.splitwiseIncluded && info.splitwiseShare > 0
                        ? ` + Trixpense (${formatCurrency(info.splitwiseShare, trip.currency)})`
                        : ''}
                    </span>
                    <div className="flex items-center gap-1 font-mono">
                      <span>
                        {over
                          ? `Over budget by ${formatCurrency(info.total - trip.budget, trip.currency)}`
                          : `${formatCurrency(Math.max(0, trip.budget - info.total), trip.currency)} remaining`}
                      </span>
                      <ChevronRight className="h-3.5 w-3.5 text-slate-500 dark:text-zinc-400 group-hover:text-slate-700 dark:group-hover:text-zinc-300 transition-colors" />
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Trip Details Modal */}
      {selectedTrip && (
        <CockpitModal
          id="trip-details-dialog"
          isOpen={Boolean(selectedTrip)}
          onClose={() => setSelectedTripId(null)}
          labelledBy="trip-details-title"
          describedBy="trip-details-description"
          size="wide"
          lockBodyScroll
          className="space-y-5"
        >
          <CockpitModalHeader
            title={selectedTrip.name}
            titleId="trip-details-title"
            description={`${selectedTrip.destination} · ${selectedTrip.startDate}${
              selectedTrip.endDate ? ` – ${selectedTrip.endDate}` : ''
            } · ${selectedTrip.currency}`}
            descriptionId="trip-details-description"
            icon={<Plane size={20} />}
            onClose={() => setSelectedTripId(null)}
            closeLabel="Close trip details"
          />

          {/* Summary banner */}
          <div className="p-4 rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
              <div>
                <span className="text-slate-600 dark:text-zinc-400 block mb-0.5 font-medium">
                  Total Spent
                </span>
                <span className="font-bold text-slate-950 dark:text-white text-base font-mono tabular-nums tracking-tight">
                  {formatCurrency(spendMap[selectedTrip.id]?.total || 0, selectedTrip.currency)}
                </span>
                {spendMap[selectedTrip.id]?.splitwiseIncluded &&
                  (spendMap[selectedTrip.id]?.splitwiseShare || 0) > 0 && (
                    <span className="block text-[10px] font-mono text-indigo-800 dark:text-indigo-300 mt-0.5">
                      Personal{' '}
                      {formatCurrency(
                        spendMap[selectedTrip.id]?.personalTotal || 0,
                        selectedTrip.currency,
                      )}{' '}
                      + Trixpense{' '}
                      {formatCurrency(
                        spendMap[selectedTrip.id]?.splitwiseShare || 0,
                        selectedTrip.currency,
                      )}
                    </span>
                  )}
              </div>
              <div>
                <span className="text-slate-600 dark:text-zinc-400 block mb-0.5 font-medium">
                  Converted (MYR)
                </span>
                <span className="font-bold text-indigo-800 dark:text-indigo-300 text-base font-mono tabular-nums tracking-tight">
                  RM {(spendMap[selectedTrip.id]?.totalMyr || 0).toFixed(2)}
                </span>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <span className="text-slate-600 dark:text-zinc-400 block mb-0.5 font-medium">
                  Trip Budget
                </span>
                <span className="font-bold text-slate-800 dark:text-zinc-200 text-base font-mono tabular-nums tracking-tight">
                  {formatCurrency(selectedTrip.budget, selectedTrip.currency)}
                </span>
              </div>
            </div>

            {selectedTrip.currency !== 'MYR' && (
              <div className="text-[11px] text-slate-700 dark:text-zinc-300 font-mono pt-2 border-t border-slate-200 dark:border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
                <span>Average Exchange Rate:</span>
                <span className="text-indigo-800 dark:text-indigo-300 font-semibold tabular-nums">
                  1 MYR ={' '}
                  {selectedTrip.rateToMyr > 0 ? (1 / selectedTrip.rateToMyr).toFixed(4) : '—'}{' '}
                  {selectedTrip.currency} (1 {selectedTrip.currency} = RM{' '}
                  {selectedTrip.rateToMyr.toFixed(4)})
                </span>
              </div>
            )}
          </div>

          {/* Unified Trip Category Breakdown (Personal + Trixpense synced, including Stay & Hotel + Flights) */}
          {(spendMap[selectedTrip.id]?.unifiedCategories.length || 0) > 0 && (
            <div className="p-4 rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <h3 className="text-xs uppercase font-semibold tracking-wider text-slate-700 dark:text-zinc-300">
                  Trip Categories Breakdown (Personal + Trixpense Synced)
                </h3>
                <span className="text-[10px] font-medium text-indigo-800 dark:text-indigo-300 bg-indigo-500/10 px-2 py-0.5 rounded-full border border-indigo-500/20">
                  Includes Stay &amp; Hotel · Flights · Food &amp; Dining
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {(spendMap[selectedTrip.id]?.unifiedCategories || []).map(cat => {
                  const totalTripSpend = spendMap[selectedTrip.id]?.total || 1;
                  const pct = Math.min(100, (cat.totalAmount / totalTripSpend) * 100);
                  const color = getCategoryColor(cat.name);
                  return (
                    <div
                      key={cat.name}
                      className="rounded-xl border border-slate-200/80 dark:border-white/[0.06] bg-white/70 dark:bg-zinc-950/50 p-2.5 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-slate-900 dark:text-white break-words leading-snug">
                          {getCategoryEmoji(cat.name)} {cat.name}
                        </span>
                        <span className="font-mono font-bold tabular-nums text-slate-950 dark:text-white shrink-0">
                          {formatCurrency(cat.totalAmount, selectedTrip.currency)}
                          {selectedTrip.currency !== 'MYR' && (
                            <span className="ml-1 text-[10px] font-normal text-slate-500 dark:text-zinc-400">
                              (RM {cat.totalMyr.toFixed(2)})
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${pct}%`, backgroundColor: color }}
                        />
                      </div>
                      {(cat.personalAmount > 0 && cat.trixpenseAmount > 0) && (
                        <div className="flex justify-between text-[10px] font-mono text-slate-500 dark:text-zinc-400">
                          <span>Personal: {formatCurrency(cat.personalAmount, selectedTrip.currency)}</span>
                          <span>Trixpense: {formatCurrency(cat.trixpenseAmount, selectedTrip.currency)}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tagged Payments List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs uppercase font-semibold tracking-wider text-slate-700 dark:text-zinc-300">
                Tagged Personal Expenses ({spendMap[selectedTrip.id]?.transactions.length || 0})
              </h3>
              <button
                onClick={() => {
                  setSelectedTripId(null);
                  setEditTransaction(null);
                  setQuickAddOpen(true);
                }}
                className="min-h-[36px] px-3 py-1 rounded-xl bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 border border-indigo-500/20 text-xs font-semibold transition-all active:scale-95 cursor-pointer touch-manipulation flex items-center gap-1"
              >
                + Add Payment
              </button>
            </div>

            <div className="max-h-72 overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] custom-scrollbar space-y-1.5 pr-1 divide-y divide-white/[0.06]">
              {(spendMap[selectedTrip.id]?.transactions || []).map(tx => {
                const isTxSameCurrency =
                  (tx.currency || 'MYR').toUpperCase() === selectedTrip.currency;
                return (
                  <div
                    key={tx.id}
                    onClick={() => {
                      setSelectedTripId(null);
                      setEditTransaction(tx as any);
                      setQuickAddOpen(true);
                    }}
                    className="flex items-center justify-between gap-3 p-3 rounded-2xl hover:bg-white/[0.04] transition-colors cursor-pointer group"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-950 dark:text-white group-hover:text-indigo-800 dark:group-hover:text-indigo-300 transition-colors">
                        {getCategoryEmoji(tx.category)} {tx.description || tx.category}
                      </p>
                      <p className="text-xs text-slate-600 dark:text-zinc-400">
                        {tx.date} • {tx.category} • {tx.account}
                      </p>
                    </div>
                    <div className="text-right shrink-0 flex items-center gap-2">
                      <div>
                        <p className="text-sm font-bold text-slate-950 dark:text-white font-mono tabular-nums tracking-tight">
                          {formatCurrency(tx.amount, tx.currency)}
                        </p>
                        {!isTxSameCurrency && (
                          <p className="text-[11px] text-slate-600 dark:text-zinc-400 font-mono tabular-nums">
                            ≈{' '}
                            {formatCurrency(
                              amountInTripCurrency(tx, selectedTrip),
                              selectedTrip.currency,
                            )}
                          </p>
                        )}
                        {selectedTrip.currency !== 'MYR' && isTxSameCurrency && (
                          <p className="text-[11px] text-indigo-800 dark:text-indigo-300 font-mono tabular-nums">
                            ≈ RM {(tx.amount * selectedTrip.rateToMyr).toFixed(2)}
                          </p>
                        )}
                      </div>
                      <ChevronRight className="h-4 w-4 text-slate-500 dark:text-zinc-400 group-hover:text-slate-700 dark:group-hover:text-zinc-300 transition-colors" />
                    </div>
                  </div>
                );
              })}
              {(spendMap[selectedTrip.id]?.transactions || []).length === 0 && (
                <p className="py-6 text-center text-xs text-slate-600 dark:text-zinc-400">
                  No personal payments tagged to this trip yet.
                </p>
              )}
            </div>
          </div>

          <SplitwiseTripPanel
            key={selectedTrip.id}
            tripId={selectedTrip.id}
            tripName={selectedTrip.name}
            tripCurrency={selectedTrip.currency}
            tripRateToMyr={selectedTrip.rateToMyr}
            onSyncUpdate={bumpSplitwiseSync}
          />

          {/* Action Buttons */}
          <div className="space-y-2 pt-2 border-t border-slate-200 dark:border-white/[0.08]">
            <button
              onClick={() => {
                const t = selectedTrip;
                setSelectedTripId(null);
                openEdit(t);
              }}
              className="w-full min-h-[44px] py-2.5 px-4 rounded-2xl bg-gradient-to-r from-indigo-500 via-indigo-600 to-purple-600 hover:from-indigo-600 hover:to-purple-700 active:scale-[0.98] text-white dark:text-white font-bold text-sm shadow-xl shadow-indigo-500/20 transition-all flex items-center justify-center gap-2 cursor-pointer touch-manipulation"
            >
              <Edit2 className="h-4 w-4" />
              <span>Edit Trip</span>
            </button>

            <button
              onClick={async () => {
                const t = selectedTrip;
                setSelectedTripId(null);
                await deleteTrip(t);
              }}
              className="w-full min-h-[40px] py-2 px-4 rounded-2xl border border-rose-500/30 hover:bg-rose-500/10 active:scale-[0.98] text-rose-800 dark:text-rose-400 font-semibold text-xs transition-colors flex items-center justify-center gap-2 cursor-pointer touch-manipulation"
            >
              <Trash2 className="h-4 w-4" />
              <span>Delete Trip</span>
            </button>
          </div>
        </CockpitModal>
      )}

      {/* Create / Edit Trip Modal */}
      <CockpitModal
        isOpen={isTripModalOpen}
        onClose={() => setIsTripModalOpen(false)}
        labelledBy="trip-editor-title"
        describedBy="trip-editor-description"
        size="standard"
        lockBodyScroll
        className="space-y-4"
      >
        <CockpitModalHeader
          title={editingTrip ? 'Edit trip' : 'Create a trip'}
          titleId="trip-editor-title"
          description={
            editingTrip
              ? 'Update your destination, dates, budget, exchange rate batches, or Trixpense link.'
              : 'Set your destination, dates, budget, or autofill from a Trixpense invite code.'
          }
          descriptionId="trip-editor-description"
          icon={<Plane size={20} />}
          onClose={() => setIsTripModalOpen(false)}
          closeLabel="Close trip editor"
        />
        <form onSubmit={saveTrip} className="mt-4 space-y-4">
          {/* Optional Quick Trixpense Link & Autofill */}
          <div className="p-3.5 rounded-2xl bg-indigo-50/70 dark:bg-indigo-500/[0.06] border border-indigo-300/50 dark:border-indigo-400/20 space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Link2 className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                <span>Link Trixpense Invite Code (Optional)</span>
              </label>
            </div>
            <div className="flex gap-2">
              <input
                placeholder="8-character code (e.g. A1B2C3D4)"
                value={modalInviteCode}
                onChange={e =>
                  setModalInviteCode(
                    e.target.value
                      .replace(/[^a-z0-9]/gi, '')
                      .slice(0, 8)
                      .toUpperCase(),
                  )
                }
                maxLength={8}
                className="h-10 flex-1 rounded-xl border border-slate-300 dark:border-white/10 bg-white dark:bg-zinc-950/70 px-3 text-xs font-mono uppercase tracking-widest text-slate-950 dark:text-white outline-none focus:border-indigo-500/70"
              />
              <button
                type="button"
                disabled={isFetchingModalSplitwise || modalInviteCode.trim().length !== 8}
                onClick={() => void handleModalFetchSplitwise()}
                className="h-10 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold transition-all cursor-pointer"
              >
                {isFetchingModalSplitwise ? 'Fetching…' : 'Fetch & Autofill'}
              </button>
            </div>
            {modalMembers.length > 0 && (
              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-700 dark:text-zinc-300">
                  Your Trixpense Member Name
                </label>
                <select
                  value={modalMemberId}
                  onChange={e => setModalMemberId(e.target.value)}
                  className="h-10 w-full rounded-xl border border-slate-300 dark:border-white/10 bg-white dark:bg-zinc-950/70 px-3 text-xs text-slate-950 dark:text-white outline-none"
                >
                  <option value="">Select your name…</option>
                  {modalMembers.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.display_name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-zinc-300">
              Trip Name
            </label>
            <input
              placeholder="e.g. Chengdu Vacation, Tokyo Autumn"
              value={tripName}
              onChange={e => setTripName(e.target.value)}
              required
              className="w-full h-11 sm:h-12 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-950/60 px-3.5 text-sm text-slate-950 dark:text-white shadow-inner outline-none focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20 transition-all placeholder:text-slate-600 dark:placeholder:text-zinc-300"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-zinc-300">
              Destination
            </label>
            <input
              placeholder="e.g. Chengdu, Sichuan / Japan"
              value={destination}
              onChange={e => setDestination(e.target.value)}
              className="w-full h-11 sm:h-12 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-950/60 px-3.5 text-sm text-slate-950 dark:text-white shadow-inner outline-none focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20 transition-all placeholder:text-slate-600 dark:placeholder:text-zinc-300"
            />
          </div>

          {/* Start Date & End Date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-zinc-300">
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                required
                className="w-full h-11 sm:h-12 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-950/60 px-2.5 sm:px-3.5 text-xs sm:text-sm text-slate-950 dark:text-white shadow-inner outline-none focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20 transition-all"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-zinc-300">
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className="w-full h-11 sm:h-12 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-950/60 px-2.5 sm:px-3.5 text-xs sm:text-sm text-slate-950 dark:text-white shadow-inner outline-none focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20 transition-all"
              />
            </div>
          </div>

          {/* Budget & Currency */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-zinc-300">
                Budget
              </label>
              <input
                type="number"
                step="any"
                placeholder="5000"
                value={budget}
                onChange={e => setBudget(e.target.value)}
                required
                className="w-full h-11 sm:h-12 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-950/60 px-3 text-sm text-slate-950 dark:text-white font-mono tabular-nums shadow-inner outline-none focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20 transition-all placeholder:text-slate-600 dark:placeholder:text-zinc-300"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-zinc-300">
                Currency
              </label>
              <select
                value={currency}
                onChange={e => applyCurrencyDefaultRate(e.target.value)}
                className="w-full h-11 sm:h-12 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-950/60 px-2.5 sm:px-3.5 text-xs sm:text-sm text-slate-950 dark:text-white shadow-inner outline-none focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20 transition-all"
              >
                {COMMON_CURRENCIES.map(c => (
                  <option key={c.code} value={c.code}>
                    {c.code} - {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <MoneyCalculator value={budget} onChange={setBudget} currency={currency} compact />

          {/* Custom Average Exchange Rate + Multi-Batch Calculator */}
          {currency !== 'MYR' && (
            <div className="p-3.5 rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <label className="text-xs font-semibold text-slate-800 dark:text-zinc-200">
                  Average Exchange Rate (MYR ⇄ {currency})
                </label>
                <button
                  type="button"
                  onClick={() => setShowBatchCalc(prev => !prev)}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-indigo-500/15 text-indigo-800 dark:text-indigo-300 border border-indigo-500/25 hover:bg-indigo-500/25 cursor-pointer"
                >
                  <Calculator className="h-3 w-3" />
                  <span>{showBatchCalc ? 'Hide Batch Calculator' : '🧮 Multi-Day Rate Calculator'}</span>
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    1 MYR = ? {currency} (e.g. 1.61)
                  </label>
                  <input
                    type="number"
                    min="0.000001"
                    step="any"
                    value={myrToForeignInput}
                    onChange={e => syncRateFromMyrToForeign(e.target.value)}
                    className="w-full h-10 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-zinc-950/80 px-3 text-sm text-slate-950 dark:text-white font-mono tabular-nums outline-none focus:border-indigo-500/60"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    1 {currency} = ? MYR (RM)
                  </label>
                  <input
                    type="number"
                    min="0.000001"
                    step="any"
                    value={rateToMyr}
                    onChange={e => syncRateFromRateToMyr(e.target.value)}
                    required
                    className="w-full h-10 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-zinc-950/80 px-3 text-sm text-slate-950 dark:text-white font-mono tabular-nums outline-none focus:border-indigo-500/60"
                  />
                </div>
              </div>

              {showBatchCalc && (
                <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/[0.05] p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-indigo-950 dark:text-indigo-200">
                      🧮 Multi-Batch Exchange Calculator (e.g. Day 1: 100 MYR → 160 {currency}, Day 2: 100 MYR → 162 {currency})
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {fxBatches.map((batch, idx) => {
                      const m = parseFloat(batch.myr);
                      const f = parseFloat(batch.foreign);
                      const rowRate = m > 0 && f > 0 ? (f / m).toFixed(4) : '—';
                      return (
                        <div key={idx} className="flex items-center gap-1.5 text-xs">
                          <span className="w-12 shrink-0 text-[10px] font-mono text-slate-500 dark:text-zinc-400">
                            Day {idx + 1}
                          </span>
                          <input
                            type="number"
                            step="any"
                            placeholder="MYR"
                            value={batch.myr}
                            onChange={e => {
                              const next = [...fxBatches];
                              next[idx] = { ...next[idx], myr: e.target.value };
                              setFxBatches(next);
                            }}
                            className="h-8 w-full rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-zinc-900 px-2 font-mono text-xs text-slate-950 dark:text-white"
                          />
                          <span className="text-[10px] font-mono text-slate-500 shrink-0">MYR →</span>
                          <input
                            type="number"
                            step="any"
                            placeholder={currency}
                            value={batch.foreign}
                            onChange={e => {
                              const next = [...fxBatches];
                              next[idx] = { ...next[idx], foreign: e.target.value };
                              setFxBatches(next);
                            }}
                            className="h-8 w-full rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-zinc-900 px-2 font-mono text-xs text-slate-950 dark:text-white"
                          />
                          <span className="text-[10px] font-mono text-indigo-800 dark:text-indigo-300 shrink-0 w-14 text-right">
                            ({rowRate})
                          </span>
                          {fxBatches.length > 1 && (
                            <button
                              type="button"
                              onClick={() => setFxBatches(fxBatches.filter((_, i) => i !== idx))}
                              className="text-slate-400 hover:text-rose-500 px-1 text-xs"
                              title="Remove batch"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() =>
                        setFxBatches([
                          ...fxBatches,
                          { myr: '', foreign: '', label: `Day ${fxBatches.length + 1}` },
                        ])
                      }
                      className="text-[11px] font-semibold text-indigo-700 dark:text-indigo-300 hover:underline cursor-pointer"
                    >
                      + Add Exchange Day
                    </button>
                    {batchSummary.avgMyrToForeign > 0 && (
                      <span className="text-[11px] font-mono font-bold text-emerald-800 dark:text-emerald-300">
                        Total: {batchSummary.totalMyr.toFixed(0)} MYR →{' '}
                        {batchSummary.totalForeign.toFixed(2)} {currency} | Avg: 1 MYR ={' '}
                        {batchSummary.avgMyrToForeign.toFixed(4)} {currency}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={applyBatchAverageRate}
                    className="w-full h-9 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold transition-all cursor-pointer"
                  >
                    Apply Weighted Average Rate (1 MYR ={' '}
                    {batchSummary.avgMyrToForeign > 0
                      ? batchSummary.avgMyrToForeign.toFixed(4)
                      : '—'}{' '}
                    {currency})
                  </button>
                </div>
              )}

              <p className="text-[11px] text-slate-600 dark:text-zinc-400 leading-relaxed">
                Current rate: <strong>1 MYR = {myrToForeignInput} {currency}</strong> (1 {currency}{' '}
                = RM {rateToMyr}).
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={addTripMutation.isPending || updateTripMutation.isPending}
            className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-500 to-purple-600 py-3 text-sm font-semibold text-white dark:text-white shadow-xl shadow-indigo-500/25 hover:from-indigo-600 hover:to-purple-700 disabled:opacity-50 transition-all cursor-pointer active:scale-[0.98] touch-manipulation"
          >
            {(addTripMutation.isPending || updateTripMutation.isPending) && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            <span>{editingTrip ? 'Save Changes' : 'Create Trip'}</span>
          </button>
        </form>
      </CockpitModal>
    </div>
  );
}
