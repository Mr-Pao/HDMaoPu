async function generateMpCode(cat) {
  if (!cat || !cat._id) {
    return;
  }
  
  try {
    const app = getApp();
    const { result } = await app.mpServerless.db.collection('cat').findOne({
      _id: cat._id
    });
    
    if (result && result.mpcode) {
      cat.mpcode = result.mpcode;
    }
  } catch (error) {
    console.error("读取小程序码字段失败:", error);
  }
}

module.exports = {
  generateMpCode
};