import React, { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Switch,
  ScrollView,
} from "react-native";
import QRCode from "react-native-qrcode-svg";

export type SendWizardAsset = {
  id: string;
  symbol: string;
  name: string;
  balance: string;
};

export type SendWizardState = {
  asset: SendWizardAsset | null;
  amount: string;
  memo: string;
  isPrivate: boolean;
  advancedFeeLevel: "standard" | "fast" | "economy";
};

const STEP_LABELS = ["Asset", "Amount", "Privacy", "Review"];

const INITIAL_STATE: SendWizardState = {
  asset: null,
  amount: "",
  memo: "",
  isPrivate: false,
  advancedFeeLevel: "standard",
};

function isAmountValid(amount: string, balance?: string): boolean {
  const value = Number(amount);
  if (!amount || Number.isNaN(value) || value <= 0) return false;
  if (balance !== undefined) {
    const balanceValue = Number(balance);
    if (!Number.isNaN(balanceValue) && value > balanceValue) return false;
  }
  return true;
}

export function isStepValid(step: number, state: SendWizardState): boolean {
  switch (step) {
    case 0:
      return state.asset !== null;
    case 1:
      return isAmountValid(state.amount, state.asset?.balance);
    case 2:
      return true;
    case 3:
      return state.asset !== null && isAmountValid(state.amount, state.asset?.balance);
    default:
      return false;
  }
}

interface SendWizardProps {
  assets: SendWizardAsset[];
  onSubmit: (state: SendWizardState) => void;
}

export default function SendWizard({ assets, onSubmit }: SendWizardProps) {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<SendWizardState>(INITIAL_STATE);

  const canGoNext = useMemo(() => isStepValid(step, state), [step, state]);
  const canSubmit = useMemo(() => isStepValid(3, state), [state]);

  const goNext = useCallback(() => {
    if (canGoNext && step < STEP_LABELS.length - 1) {
      setStep((s) => s + 1);
    }
  }, [canGoNext, step]);

  const goBack = useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  const updateState = useCallback((patch: Partial<SendWizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSubmit = useCallback(() => {
    if (canSubmit) onSubmit(state);
  }, [canSubmit, onSubmit, state]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ProgressIndicator currentStep={step} labels={STEP_LABELS} />

      {step === 0 && (
        <AssetSelectionStep
          assets={assets}
          selected={state.asset}
          onSelect={(asset) => updateState({ asset })}
        />
      )}

      {step === 1 && (
        <AmountMemoStep
          amount={state.amount}
          memo={state.memo}
          balance={state.asset?.balance}
          onChangeAmount={(amount) => updateState({ amount })}
          onChangeMemo={(memo) => updateState({ memo })}
        />
      )}

      {step === 2 && (
        <PrivacyAdvancedStep
          isPrivate={state.isPrivate}
          feeLevel={state.advancedFeeLevel}
          onTogglePrivate={(isPrivate) => updateState({ isPrivate })}
          onChangeFeeLevel={(advancedFeeLevel) => updateState({ advancedFeeLevel })}
        />
      )}

      {step === 3 && <ReviewStep state={state} />}

      <View style={styles.navRow}>
        <TouchableOpacity
          style={[styles.navButton, step === 0 && styles.navButtonDisabled]}
          onPress={goBack}
          disabled={step === 0}
        >
          <Text style={styles.navButtonText}>Back</Text>
        </TouchableOpacity>

        {step < STEP_LABELS.length - 1 ? (
          <TouchableOpacity
            style={[styles.navButton, !canGoNext && styles.navButtonDisabled]}
            onPress={goNext}
            disabled={!canGoNext}
          >
            <Text style={styles.navButtonText}>Next</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.navButton, !canSubmit && styles.navButtonDisabled]}
            onPress={handleSubmit}
            disabled={!canSubmit}
          >
            <Text style={styles.navButtonText}>Submit</Text>
          </TouchableOpacity>
        )}
      </View>
    </ScrollView>
  );
}

function ProgressIndicator({
  currentStep,
  labels,
}: {
  currentStep: number;
  labels: string[];
}) {
  return (
    <View style={styles.progressRow}>
      {labels.map((label, index) => (
        <View key={label} style={styles.progressStep}>
          <View
            style={[
              styles.progressDot,
              index <= currentStep && styles.progressDotActive,
            ]}
          >
            <Text style={styles.progressDotText}>{index + 1}</Text>
          </View>
          <Text style={styles.progressLabel}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

function AssetSelectionStep({
  assets,
  selected,
  onSelect,
}: {
  assets: SendWizardAsset[];
  selected: SendWizardAsset | null;
  onSelect: (asset: SendWizardAsset) => void;
}) {
  return (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Select an asset</Text>
      {assets.map((asset) => (
        <TouchableOpacity
          key={asset.id}
          style={[
            styles.assetRow,
            selected?.id === asset.id && styles.assetRowSelected,
          ]}
          onPress={() => onSelect(asset)}
        >
          <Text style={styles.assetSymbol}>{asset.symbol}</Text>
          <Text style={styles.assetName}>{asset.name}</Text>
          <Text style={styles.assetBalance}>{asset.balance}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function AmountMemoStep({
  amount,
  memo,
  balance,
  onChangeAmount,
  onChangeMemo,
}: {
  amount: string;
  memo: string;
  balance?: string;
  onChangeAmount: (v: string) => void;
  onChangeMemo: (v: string) => void;
}) {
  const valid = isAmountValid(amount, balance);
  return (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Amount and memo</Text>
      <TextInput
        style={styles.input}
        keyboardType="decimal-pad"
        placeholder="0.00"
        value={amount}
        onChangeText={onChangeAmount}
      />
      {!valid && amount.length > 0 && (
        <Text style={styles.errorText}>
          {balance !== undefined && Number(amount) > Number(balance)
            ? "Amount exceeds available balance"
            : "Enter a valid amount"}
        </Text>
      )}
      <TextInput
        style={styles.input}
        placeholder="Memo (optional)"
        value={memo}
        onChangeText={onChangeMemo}
        maxLength={140}
      />
    </View>
  );
}

function PrivacyAdvancedStep({
  isPrivate,
  feeLevel,
  onTogglePrivate,
  onChangeFeeLevel,
}: {
  isPrivate: boolean;
  feeLevel: SendWizardState["advancedFeeLevel"];
  onTogglePrivate: (v: boolean) => void;
  onChangeFeeLevel: (v: SendWizardState["advancedFeeLevel"]) => void;
}) {
  const levels: SendWizardState["advancedFeeLevel"][] = ["economy", "standard", "fast"];
  return (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Privacy and advanced options</Text>
      <View style={styles.switchRow}>
        <Text>Private transaction</Text>
        <Switch value={isPrivate} onValueChange={onTogglePrivate} />
      </View>
      <Text style={styles.stepSubtitle}>Fee level</Text>
      <View style={styles.feeRow}>
        {levels.map((level) => (
          <TouchableOpacity
            key={level}
            style={[styles.feeOption, feeLevel === level && styles.feeOptionSelected]}
            onPress={() => onChangeFeeLevel(level)}
          >
            <Text>{level}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

function ReviewStep({ state }: { state: SendWizardState }) {
  const qrValue = useMemo(
    () =>
      JSON.stringify({
        asset: state.asset?.symbol,
        amount: state.amount,
        memo: state.memo,
        private: state.isPrivate,
        fee: state.advancedFeeLevel,
      }),
    [state]
  );

  return (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Review and confirm</Text>
      <Text>Asset: {state.asset?.name ?? "-"}</Text>
      <Text>Amount: {state.amount || "-"}</Text>
      <Text>Memo: {state.memo || "-"}</Text>
      <Text>Private: {state.isPrivate ? "Yes" : "No"}</Text>
      <Text>Fee level: {state.advancedFeeLevel}</Text>
      <View style={styles.qrContainer}>
        <QRCode value={qrValue} size={160} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  progressRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 24 },
  progressStep: { alignItems: "center", flex: 1 },
  progressDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#ddd",
    alignItems: "center",
    justifyContent: "center",
  },
  progressDotActive: { backgroundColor: "#4361ee" },
  progressDotText: { color: "#fff", fontSize: 12 },
  progressLabel: { fontSize: 11, marginTop: 4, textAlign: "center" },
  stepContainer: { marginBottom: 24 },
  stepTitle: { fontSize: 18, fontWeight: "600", marginBottom: 12 },
  stepSubtitle: { fontSize: 14, fontWeight: "500", marginTop: 12, marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  errorText: { color: "#d64545", marginBottom: 8, fontSize: 12 },
  assetRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 12,
    borderWidth: 1,
    borderColor: "#eee",
    borderRadius: 8,
    marginBottom: 8,
  },
  assetRowSelected: { borderColor: "#4361ee", backgroundColor: "#eef1ff" },
  assetSymbol: { fontWeight: "600" },
  assetName: { color: "#666" },
  assetBalance: { color: "#333" },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  feeRow: { flexDirection: "row", gap: 8 },
  feeOption: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
  },
  feeOptionSelected: { borderColor: "#4361ee", backgroundColor: "#eef1ff" },
  qrContainer: { alignItems: "center", marginTop: 16 },
  navRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  navButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    backgroundColor: "#4361ee",
    borderRadius: 8,
  },
  navButtonDisabled: { backgroundColor: "#ccc" },
  navButtonText: { color: "#fff", fontWeight: "600" },
});
