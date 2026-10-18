/** Small stroke icons; the mobile app draws its own from Views (src/ui/icons.tsx). */
import type { ReactNode } from 'react';

type Props = { size?: number };

const svg = (size: number, body: ReactNode, fill = false) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill ? 'currentColor' : 'none'}
    stroke={fill ? 'none' : 'currentColor'}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true">
    {body}
  </svg>
);

export const PlayIcon = ({ size = 22 }: Props) => svg(size, <path d="M7 4.5v15l12.5-7.5z" />, true);
export const PauseIcon = ({ size = 22 }: Props) =>
  svg(size, <><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></>, true);
export const SkipIcon = ({ size = 20, direction }: Props & { direction: -1 | 1 }) =>
  svg(size, direction > 0 ? <><path d="M5 5l9 7-9 7z" /><path d="M18 5v14" /></> : <><path d="M19 5l-9 7 9 7z" /><path d="M6 5v14" /></>);
export const BackIcon = ({ size = 20 }: Props) => svg(size, <path d="M15 5l-7 7 7 7" />);
export const PlusIcon = ({ size = 18 }: Props) => svg(size, <path d="M12 5v14M5 12h14" />);
export const CloseIcon = ({ size = 18 }: Props) => svg(size, <path d="M6 6l12 12M18 6L6 18" />);
export const TrashIcon = ({ size = 16 }: Props) =>
  svg(size, <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />);
