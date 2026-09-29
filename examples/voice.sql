-- Replace metadata and upload the matching WAV before enabling.
INSERT INTO voices(id,name,available,description,reference_key,reference_text,reference_seconds)
VALUES('demo','示例声线',0,'自有或获授权的原声','references/demo.wav','与参考音频逐字对应的文本',8.0);
-- After verified upload:
-- UPDATE voices SET available=1 WHERE id='demo';
