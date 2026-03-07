const fs = require("fs");
const path = require("path");

function findTestFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      findTestFiles(filePath, fileList);
    } else if (file.endsWith(".test.js")) {
      const relativePath = path.relative(__dirname, filePath);
      fileList.push(relativePath);
    }
  });

  return fileList;
}

const testsDir = __dirname;
const testFiles = findTestFiles(testsDir);

testFiles.forEach((file) => {
  console.log(`npx jest ${file} --forceExit --testTimeout=30000`);
});
