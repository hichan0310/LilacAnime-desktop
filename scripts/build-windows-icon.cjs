const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sources = ['mdpi','hdpi','xhdpi','xxhdpi','xxxhdpi'].map(density =>
  path.join(root, 'app', 'src', 'main', 'res', `mipmap-${density}`, 'ic_launcher.png')
).concat(path.join(root, 'build', 'icon.png'));

const images = sources.map(file => {
  const data = fs.readFileSync(file);
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  return { data, width:data.readUInt32BE(16), height:data.readUInt32BE(20) };
});

const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((image, index) => {
  const entry = 6 + index * 16;
  header[entry] = image.width >= 256 ? 0 : image.width;
  header[entry + 1] = image.height >= 256 ? 0 : image.height;
  header[entry + 2] = 0;
  header[entry + 3] = 0;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.data.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.data.length;
});

const destination = path.join(root, 'build', 'icon.ico');
fs.mkdirSync(path.dirname(destination), { recursive:true });
fs.writeFileSync(destination, Buffer.concat([header, ...images.map(image => image.data)]));
console.log(`Created ${destination}: ${images.map(image => `${image.width}x${image.height}`).join(', ')}`);
