const nacos = {
  serverList: '10.14.100.131:8848', // Nacos 服务器地址
  namespace: 'public', // 命名空间
  serviceName: 'admin-backend', // 服务名称
  dataId: 'admin-backend.json', // 配置文件 ID
  group: 'DEFAULT_GROUP', // 配置文件分组
  userCenterServiceName: 'user-center', // 用户中心服务名
};

module.exports = nacos;
