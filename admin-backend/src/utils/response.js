module.exports = {
    success: (data = null, message = 'Success') => ({
        success: true,
        message,
        data
    }),
    error: (message = 'Error', code = 400, errors = null) => ({
        success: false,
        message,
        code,
        errors
    })
};
