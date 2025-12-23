const barcode = require('./lib/cpp-bridge');

module.exports = {
  decode: barcode.decode,
  decodeWithPreprocessing: barcode.decodeWithPreprocessing,
  resizeImage: barcode.resizeImage,
  convertToMat: barcode.convertToMat,
  // New decoder primitives
  decode_zbar: barcode.decode_zbar,
  decode_zxing: barcode.decode_zxing,
  // Preprocessing functions
  preprocess_original: barcode.preprocess_original,
  preprocess_histogram: barcode.preprocess_histogram,
  preprocess_otsu: barcode.preprocess_otsu
};
