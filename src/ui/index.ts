/**
 * src/ui — the design system.
 *
 * Tokens, one text primitive, the §5 component recipes and the §6 charts. Screens compose
 * from here and hold no design values of their own.
 *
 * The three rules that outrank convenience:
 *   1. Green and red mean profit and loss. Selection is white-on-dark.
 *   2. Hit targets are ≥44pt. Small controls grow their touch area, not their circle.
 *   3. Nothing animates that isn't in animations.md, and a price never animates at all.
 */

export * from './tokens';
export { FONTS, DISPLAY_FONT, familyFor, type FontWeightKey } from './fonts';
export {
  type as typeScale,
  numericVariants,
  variantColor,
  MIN_FONT_SIZE,
  type TypeVariant,
} from './type';
export {
  DESIGN_WIDTH,
  DESIGN_HEIGHT,
  NARROW_WIDTH,
  SHORT_HEIGHT,
  metrics,
  scaleFont,
  hitTarget,
  snap,
} from './responsive';

export { MINUS, money, percent, price, quantity, wholeMoney } from './format';
export {
  Text,
  Value,
  Price,
  pnlTone,
  useBalancesHidden,
  useSpokenFigure,
  FigureSpan,
  type TextProps,
  type ValueProps,
  type PriceProps,
  type PriceTone,
} from './Text';
export {
  MASK,
  maskFigure,
  maskLine,
  maskMode,
  spokenFigure,
  type FigureKind,
  type MaskMode,
  type MaskedLine,
} from './mask';
export { Press, hitSlopFor, PRESSED_OPACITY, type PressProps } from './Press';
export { arrival, easing, timing, useReducedMotion } from './motion';

export { Screen, Fill, type ScreenProps } from './Screen';
export { PhoneFrame } from './PhoneFrame';
export { Row, type RowProps } from './Row';
export { Pill, PillRow, PillWrap, ChoiceChip, type PillProps, type PillRowProps } from './Pill';
export { Segmented, type SegmentedProps, type SegmentedOption } from './Segmented';
export { Stepper, type StepperProps } from './Stepper';
export { Switch, SwitchRow, type SwitchProps, type SwitchRowProps } from './Switch';
export {
  AgentOrb,
  AssetMark,
  type AgentOrbProps,
  type AgentStage,
  type OrbSize,
  type OrbStatus,
} from './AgentOrb';
export {
  SheetCard,
  BottomSheet,
  ConsequenceCard,
  type SheetCardProps,
  type BottomSheetProps,
} from './SheetCard';
export {
  Button,
  ButtonRow,
  ButtonPair,
  type ButtonProps,
  type ButtonRowProps,
  type ButtonVariant,
} from './Button';
export { HoldButton, type HoldButtonProps } from './HoldButton';
export { StopCurtain, type StopCurtainProps, type StopState } from './StopCurtain';
export { Eyebrow, type EyebrowProps } from './Eyebrow';
export { BackButton, CloseButton, IconButton, HeaderBar, type IconButtonProps } from './IconButton';
export { Progress, type ProgressProps } from './Progress';
export { Placeholder, LoadingRows, ErrorState, EmptyState, EmptyList, FailureNote } from './States';
export { EMPTY_LISTS, emptyList, type EmptyListKey, type EmptyListCopy } from './emptyActions';
export { SignInPrompt, SignInButton, signIn } from './SignIn';
export { RadioCard, type RadioCardProps } from './RadioCard';
export { Keypad, KEYPAD_KEYS, type KeypadProps, type KeypadKey } from './Keypad';
export { Tag, DeltaChip, type TagProps, type TagTone } from './Tag';
export { NoteStrip, noteDotColor, type NoteStripProps, type NoteKind } from './NoteStrip';
export { StatTile, StatGrid, StatRow, type StatTileProps, type StatGridProps } from './StatTile';
export { TabBar, TAB_ORDER, type TabBarProps, type TabKey } from './TabBar';

export * from './charts';
export { Ring, type RingProps } from './charts/Ring';
