import HalinQuery from '../HalinQuery';

export default new HalinQuery({
    query: `
    CALL dbms.queryJmx("java.lang:type=OperatingSystem") 
    YIELD attributes 
    WITH
        attributes.OpenFileDescriptorCount.value as fdOpen,
        attributes.MaxFileDescriptorCount.value as fdMax
    RETURN 
        fdOpen, fdMax
    `,
    columns: [
        { Header: 'fdOpen', accessor: 'fdOpen' },
        { Header: 'fdMax', accessor: 'fdMax' },
    ],
    rate: 2000,
});