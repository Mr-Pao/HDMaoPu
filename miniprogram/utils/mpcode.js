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
    console.error("??????????????:", error);
  }
}

module.exports = {
  generateMpCode
};