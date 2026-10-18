package main

type voice struct {
	Code   string `json:"code"`
	Name   string `json:"name"`
	Gender string `json:"gender"`
}

// kokoroModelVersion names the model and text normalization the worker runs. Keep in sync with
// MODEL_VERSION in kokoro-worker/app.py; it prefixes cache keys so stale audio is never served.
const kokoroModelVersion = "kokoro-vietnamese-a249afe-norm2"

const defaultKokoroVoice = "mai_loan"

// kokoroVoices are the voicepacks the worker loads. Keep in sync with VOICES in kokoro-worker/app.py.
var kokoroVoices = []voice{
	{Code: "diem_trinh", Name: "Diễm Trinh", Gender: "female"},
	{Code: "hung_thinh", Name: "Hưng Thịnh", Gender: "male"},
	{Code: "mai_linh", Name: "Mai Linh", Gender: "female"},
	{Code: "mai_loan", Name: "Mai Loan", Gender: "female"},
	{Code: "manh_dung", Name: "Mạnh Dũng", Gender: "male"},
	{Code: "my_yen", Name: "Mỹ Yến", Gender: "female"},
	{Code: "ngoc_huyen", Name: "Ngọc Huyền", Gender: "female"},
	{Code: "phat_tai", Name: "Phát Tài", Gender: "male"},
	{Code: "thanh_dat", Name: "Thành Đạt", Gender: "male"},
	{Code: "thuc_trinh", Name: "Thục Trinh", Gender: "female"},
	{Code: "tuan_ngoc", Name: "Tuấn Ngọc", Gender: "male"},
	{Code: "duc_an", Name: "Đức An", Gender: "male"},
	{Code: "duc_duy", Name: "Đức Duy", Gender: "male"},
}

// kokoroVoiceOr returns code when it is a Kokoro voice, else the default.
// Installed apps still send old Vbee voice codes; they keep working with the default voice.
func kokoroVoiceOr(code string) string {
	for _, v := range kokoroVoices {
		if v.Code == code {
			return code
		}
	}
	return defaultKokoroVoice
}
