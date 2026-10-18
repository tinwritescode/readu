// The voices. Kokoro's are the same on the server (backend/voices.go) and on this computer; VieNeu's read only
// on this computer.
import type { LocalModel, Voice } from './types';

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

/** VieNeu v3 Turbo's preset voices, editors' picks first, as in vendor/vieneu/voices_v3_turbo.json. */
export const VIENEU_VOICES: Voice[] = [
  { code: 'vieneu:Adam bựa', name: 'Adam bựa', gender: 'male', model: 'vieneu' },
  { code: 'vieneu:Trúc Ly', name: 'Trúc Ly', gender: 'female', model: 'vieneu' },
  { code: 'vieneu:Thiện Minh', name: 'Thiện Minh', gender: 'male', model: 'vieneu' },
  { code: 'vieneu:Mai Anh', name: 'Mai Anh', gender: 'female', model: 'vieneu' },
  { code: 'vieneu:Hải Đăng', name: 'Hải Đăng', gender: 'male', model: 'vieneu' },
  { code: 'vieneu:Thùy Dung', name: 'Thùy Dung', gender: 'female', model: 'vieneu' },
  { code: 'vieneu:Thiền Tâm Đức', name: 'Thiền Tâm Đức', gender: 'male', model: 'vieneu' },
  { code: 'vieneu:Ngọc Huyền', name: 'Ngọc Huyền', gender: 'female', model: 'vieneu' },
  { code: 'vieneu:Quang Sơn', name: 'Quang Sơn', gender: 'male', model: 'vieneu' },
  { code: 'vieneu:Ngọc Trân', name: 'Ngọc Trân', gender: 'female', model: 'vieneu' },
  { code: 'vieneu:Minh Đức', name: 'Minh Đức', gender: 'male', model: 'vieneu' },
  { code: 'vieneu:Phạm Tuyên', name: 'Phạm Tuyên', gender: 'male', model: 'vieneu' },
  { code: 'vieneu:Thái Sơn', name: 'Thái Sơn', gender: 'male', model: 'vieneu' },
  { code: 'vieneu:Xuân Vĩnh', name: 'Xuân Vĩnh', gender: 'male', model: 'vieneu' },
  { code: 'vieneu:Thanh Bình', name: 'Thanh Bình', gender: 'male', model: 'vieneu' },
  { code: 'vieneu:Ngọc Linh', name: 'Ngọc Linh', gender: 'female', model: 'vieneu' },
  { code: 'vieneu:Đoan Trang', name: 'Đoan Trang', gender: 'female', model: 'vieneu' },
  { code: 'vieneu:Thục Đoan', name: 'Thục Đoan', gender: 'female', model: 'vieneu' },
  { code: 'vieneu:Minh Triết', name: 'Minh Triết', gender: 'male', model: 'vieneu' },
  { code: 'vieneu:Mỹ Duyên', name: 'Mỹ Duyên', gender: 'female', model: 'vieneu' },
  { code: 'vieneu:Quỳnh Anh', name: 'Quỳnh Anh', gender: 'female', model: 'vieneu' },
  { code: 'vieneu:Đức Trí', name: 'Đức Trí', gender: 'male', model: 'vieneu' },
  { code: 'vieneu:Kim Thanh', name: 'Kim Thanh', gender: 'female', model: 'vieneu' },
  { code: 'vieneu:Adam', name: 'Adam', gender: 'male', model: 'vieneu' },
  { code: 'vieneu:Quốc Tuấn', name: 'Quốc Tuấn', gender: 'male', model: 'vieneu' },
];

const VIENEU_PREFIX = 'vieneu:';

/** The model that reads a voice: VieNeu voices are prefixed, everything else is Kokoro. */
export const modelOf = (voice: string): LocalModel => (voice.startsWith(VIENEU_PREFIX) ? 'vieneu' : 'kokoro');

/** A VieNeu voice's preset name, as the voices file keys it. */
export const vieneuPreset = (voice: string) => voice.slice(VIENEU_PREFIX.length);
