// The Kokoro voices, the same on the server (backend/voices.go) and on this computer.
import type { Voice } from './types';

export const KOKORO_VOICES: Voice[] = [
  { code: 'diem_trinh', name: 'Diễm Trinh', gender: 'female' },
  { code: 'hung_thinh', name: 'Hưng Thịnh', gender: 'male' },
  { code: 'mai_linh', name: 'Mai Linh', gender: 'female' },
  { code: 'mai_loan', name: 'Mai Loan', gender: 'female' },
  { code: 'manh_dung', name: 'Mạnh Dũng', gender: 'male' },
  { code: 'my_yen', name: 'Mỹ Yến', gender: 'female' },
  { code: 'ngoc_huyen', name: 'Ngọc Huyền', gender: 'female' },
  { code: 'phat_tai', name: 'Phát Tài', gender: 'male' },
  { code: 'thanh_dat', name: 'Thành Đạt', gender: 'male' },
  { code: 'thuc_trinh', name: 'Thục Trinh', gender: 'female' },
  { code: 'tuan_ngoc', name: 'Tuấn Ngọc', gender: 'male' },
  { code: 'duc_an', name: 'Đức An', gender: 'male' },
  { code: 'duc_duy', name: 'Đức Duy', gender: 'male' },
];
